import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoWorkspace, createApproval } from '../dist/lib/core.mjs';
import {
  MAX_RECEIPT_BYTES, validateReceiptBundle, parseReceiptFile, serializeReceiptBundle,
  upsertObservation, verificationPlan, liveSummary, creditStatusKey
} from '../dist/lib/receipt-ui.mjs';

// Deliberately synthetic format fixtures, never real transactions or chain proof.
const signature = '2'.repeat(88);
const otherSignature = '3'.repeat(88);
async function bundle(withApproval = true) {
  const demo = await createDemoWorkspace();
  const version = demo.versions[0], approval = demo.approvals[0];
  return { kind: 'versionpass.receipt-bundle', schema: 1, network: 'solana-devnet',
    versions: [version], approvals: withApproval ? [approval] : [],
    anchors: [{ recordId: version.versionId, signature },
      ...(withApproval ? [{ recordId: approval.approvalId, signature: otherSignature }] : [])] };
}
const verified = record => ({ state: 'rpc-verified', recordId: record.approvalId || record.versionId });

test('import requires the exact bundle schema and never retains extra personal fields', async () => {
  const receipt = await bundle();
  for (const mutate of [
    value => { value.email = 'synthetic@example.invalid'; },
    value => { value.privateKey = [1, 2, 3]; },
    value => { value.versions[0].filename = '<img src=x onerror=alert(1)>'; },
    value => { value.approvals[0].notes = 'synthetic private note'; },
    value => { value.anchors[0].state = 'rpc-verified'; },
  ]) {
    const untrusted = structuredClone(receipt); mutate(untrusted);
    await assert.rejects(validateReceiptBundle(untrusted));
  }
  const checked = await validateReceiptBundle(receipt);
  assert.deepEqual(Object.keys(checked), ['kind', 'schema', 'network', 'versions', 'approvals', 'anchors']);
  assert.equal(Object.isFrozen(checked), true);
});

test('oversized receipt is rejected before text allocation or JSON parsing', async () => {
  let read = false;
  const oversized = new Blob([new Uint8Array(MAX_RECEIPT_BYTES + 1)]);
  oversized.text = async () => { read = true; throw new Error('must-not-read'); };
  await assert.rejects(parseReceiptFile(oversized));
  assert.equal(read, false);
  await assert.rejects(parseReceiptFile(new Blob(['null'])));
  await assert.rejects(parseReceiptFile(new Blob(['{"versions": []}'])));
});

test('duplicate, foreign and ambiguous anchor/review records cannot be imported', async () => {
  const receipt = await bundle();
  for (const mutate of [
    value => value.anchors.push({ ...value.anchors[0] }),
    value => { value.anchors[0].recordId = 'ab'.repeat(32); },
    value => { value.anchors[1].signature = value.anchors[0].signature; },
    value => value.approvals.push({ ...value.approvals[0] }),
  ]) {
    const copy = structuredClone(receipt); mutate(copy);
    await assert.rejects(validateReceiptBundle(copy));
  }
  const contradictory = structuredClone(receipt);
  contradictory.approvals.push(await createApproval({ version: receipt.versions[0],
    reviewerPublicKey: receipt.versions[0].expectedReviewerPublicKey, decision: 'changes_requested',
    createdAt: '2026-11-02T00:06:00.000Z', nonce: '34'.repeat(16) }));
  await assert.rejects(validateReceiptBundle(contradictory));
});

test('verified delivery without an approval is never summarized as approval verified', async () => {
  const receipt = await validateReceiptBundle(await bundle(false));
  const plan = verificationPlan(receipt);
  assert.equal(plan.records.length, 1);
  assert.equal(liveSummary(plan, [verified(plan.version)]), 'delivery-only');
  assert.equal(liveSummary(plan, []), 'unverified');
  assert.equal(liveSummary(plan, [{ ...verified(plan.version), state: 'pending' }]), 'unverified');
});

test('approval success requires both exact version and review observations; failed never passes', async () => {
  const plan = verificationPlan(await validateReceiptBundle(await bundle()));
  const good = plan.records.map(verified);
  assert.equal(liveSummary(plan, good), 'approved');
  assert.equal(liveSummary(plan, [good[1]]), 'unverified');
  assert.equal(liveSummary(plan, [...good].reverse()), 'unverified');
  for (const state of ['pending', 'failed']) {
    assert.equal(liveSummary(plan, [{ ...good[0], state }, good[1]]), 'unverified');
    assert.equal(liveSummary(plan, [good[0], { ...good[1], state }]), 'unverified');
  }
});

test('a verified changes-requested decision remains explicitly not approved', async () => {
  const receipt = await bundle();
  const approval = await createApproval({ version: receipt.versions[0],
    reviewerPublicKey: receipt.versions[0].expectedReviewerPublicKey, decision: 'changes_requested',
    createdAt: '2026-11-02T00:06:00.000Z', nonce: '45'.repeat(16) });
  receipt.approvals = [approval]; receipt.anchors[1].recordId = approval.approvalId;
  const plan = verificationPlan(await validateReceiptBundle(receipt));
  assert.equal(liveSummary(plan, plan.records.map(verified)), 'changes-requested');
});

test('pending rechecks replace the same anchor and cannot preserve an old verified status', async () => {
  const receipt = await bundle(false), record = receipt.versions[0];
  let anchors = upsertObservation([], record, { state: 'pending', signature });
  anchors = upsertObservation(anchors, record, { state: 'rpc-verified', signature });
  anchors = upsertObservation(anchors, record, { state: 'failed', signature });
  assert.equal(anchors.length, 1); assert.equal(anchors[0].state, 'failed');
  assert.equal(anchors[0].signature, signature);
  assert.throws(() => upsertObservation(anchors, record, { state: 'rpc-verified', signature, recordId: 'ff'.repeat(32) }));
});

test('exports round-trip only canonical public records and signatures, never labels or observations', async () => {
  const original = await bundle();
  const serialized = await serializeReceiptBundle(original);
  assert.deepEqual(await parseReceiptFile(new Blob([serialized])), await validateReceiptBundle(original));
  assert.ok(new TextEncoder().encode(serialized).byteLength <= MAX_RECEIPT_BYTES);
  for (const word of ['filename', 'privateKey', 'secretKey', 'labels', 'rpc-verified', 'explorer']) assert.equal(serialized.includes(word), false);
});

test('HTTP 410 faucet unavailability is not a pending transfer or a rate-limit claim', () => {
  assert.equal(creditStatusKey({ funded: false, requested: true, signature: null, reason: 'faucet-unavailable', httpStatus: 410 }), 'creditsUnavailable');
  assert.equal(creditStatusKey({ funded: false, signature, reason: 'transaction-failed' }), 'creditsFailed');
  assert.equal(creditStatusKey({ funded: false, signature, reason: 'awaiting-finality' }), 'creditsPending');
  assert.equal(creditStatusKey({ funded: false, signature, reason: 'faucet-already-attempted' }), 'creditsUnknown');
  assert.equal(creditStatusKey({ funded: true, requested: false }), 'creditsReady');
});
