import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORK, DEVNET_RPC, MEMO_PROGRAM_ID, MAX_FILE_BYTES, randomId, hashBytes, hashFile,
  createVersion, verifyVersion, verifyFile, validateVersionChain, createApproval,
  verifyApproval, memoForVersion, memoForApproval, verifyAnchorObservation, createDemoWorkspace
} from '../dist/lib/core.mjs';

const creator = '11111111111111111111111111111111';
const reviewer = MEMO_PROGRAM_ID;
const other = 'ComputeBudget111111111111111111111111111111';
const signature = '1'.repeat(64); // Deliberately synthetic RPC test fixture, not a live tx.
const at = '2026-11-02T01:00:00.000Z';
const copy = value => structuredClone(value);
async function version(overrides = {}) {
  return createVersion({ projectId: 'ab'.repeat(16), ordinal: 1, fileSha256: await hashBytes(new TextEncoder().encode('alpha')),
    fileBytes: 5, creatorPublicKey: creator, expectedReviewerPublicKey: reviewer, createdAt: at,
    nonce: 'cd'.repeat(16), ...overrides });
}
async function approval(v, overrides = {}) {
  return createApproval({ version: v, reviewerPublicKey: reviewer, decision: 'approved',
    createdAt: '2026-11-02T01:01:00.000Z', nonce: 'ef'.repeat(16), ...overrides });
}
function observation(record, v) {
  const memo = record.kind === 'versionpass.version' ? memoForVersion(record) : memoForApproval(record);
  const signerPublicKey = record.kind === 'versionpass.version' ? record.creatorPublicKey : record.reviewerPublicKey;
  return { record, version: v, signature, signerPublicKey, rpcUrl: DEVNET_RPC, observedAt: at,
    status: { slot: 123, err: null, confirmationStatus: 'finalized', confirmations: null },
    transaction: { slot: 123, blockTime: 1793581200, meta: { err: null }, transaction: {
      signatures: [signature], message: { accountKeys: [{ pubkey: signerPublicKey, signer: true, writable: true }],
        instructions: [{ programId: MEMO_PROGRAM_ID, program: 'spl-memo', parsed: memo }] } } } };
}

test('known SHA-256 vector, view slicing and immutable byte snapshot', async () => {
  assert.equal(await hashBytes(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const bytes = new Uint8Array([0, 97, 98, 99, 0]);
  const result = hashBytes(bytes.subarray(1, 4)); bytes.fill(0);
  assert.equal(await result, await hashBytes(new TextEncoder().encode('abc')));
  await assert.rejects(hashBytes('abc'), { code: 'invalid-bytes' });
});

test('local file comparison distinguishes same length different content and rename', async () => {
  const v = await version();
  assert.equal((await verifyFile(v, new Blob(['alpha']))).matches, true);
  assert.equal((await verifyFile(v, new Blob(['bravo']))).matches, false);
  assert.equal((await verifyFile(v, new File(['alpha'], 'any-local-name.txt'))).matches, true);
  const fake = { size: 5, arrayBuffer: async () => new ArrayBuffer(5) };
  await assert.rejects(hashFile(fake), { code: 'invalid-file' });
  assert.equal(MAX_FILE_BYTES, 67108864);
});

test('version commitment binds designated reviewer, file and parent; remains immutable', async () => {
  const v = await version();
  assert.deepEqual(await verifyVersion(v), v);
  assert.equal(Object.isFrozen(v), true);
  for (const overrides of [{ fileBytes: 4 }, { expectedReviewerPublicKey: other }, { fileSha256: 'a'.repeat(64) }]) {
    await assert.rejects(verifyVersion({ ...v, ...overrides }), { code: 'version-tampered' });
  }
  assert.notEqual((await version({ expectedReviewerPublicKey: other })).versionId, v.versionId);
  assert.throws(() => { v.fileBytes = 4; }, TypeError);
});

test('strict schemas reject leaked metadata, primitive coercion, invalid time and size', async () => {
  for (const overrides of [{ filename: 'private.txt' }, { ordinal: [1] }, { fileBytes: -1 },
    { fileBytes: MAX_FILE_BYTES + 1 }, { createdAt: '2026-02-30T00:00:00.000Z' },
    { nonce: 'random' }, { creatorPublicKey: ['11111111111111111111111111111111'] }, { expectedReviewerPublicKey: undefined }]) {
    await assert.rejects(version(overrides));
  }
  await assert.rejects(verifyVersion({ ...await version(), secretKey: [1, 2, 3] }), { code: 'unexpected-fields' });
  assert.match(randomId(), /^[a-f0-9]{32}$/);
});

test('version chain rejects stale-parent branch, reordering, foreign project and creator', async () => {
  const first = await version();
  const second = await version({ ordinal: 2, previousVersionId: first.versionId, nonce: '01'.repeat(16) });
  assert.equal((await validateVersionChain([first, second])).length, 2);
  await assert.rejects(validateVersionChain([second, first]), { code: 'broken-version-chain' });
  await assert.rejects(validateVersionChain([first, await version({ ordinal: 2, previousVersionId: '0'.repeat(64) })]), { code: 'broken-version-chain' });
  for (const overrides of [{ projectId: '00'.repeat(16) }, { creatorPublicKey: other }]) {
    await assert.rejects(validateVersionChain([first, await version({ ordinal: 2, previousVersionId: first.versionId, ...overrides })]), { code: 'broken-version-chain' });
  }
});

test('only designated reviewer may create approval and cross-version replay fails', async () => {
  const first = await version();
  const accepted = await approval(first);
  assert.deepEqual(await verifyApproval(accepted, first), accepted);
  await assert.rejects(approval(first, { reviewerPublicKey: other }), { code: 'wrong-reviewer' });
  await assert.rejects(verifyApproval({ ...accepted, reviewerPublicKey: other }, first), { code: 'wrong-reviewer' });
  const second = await version({ ordinal: 2, previousVersionId: first.versionId });
  await assert.rejects(verifyApproval(accepted, second), { code: 'approval-wrong-version' });
  await assert.rejects(verifyApproval({ ...accepted, decision: 'changes_requested' }, first), { code: 'approval-tampered' });
});

test('approval decision is explicit and cannot predate its version', async () => {
  const v = await version();
  await assert.rejects(approval(v, { decision: 'yes' }), { code: 'invalid-decision' });
  await assert.rejects(approval(v, { createdAt: '2026-11-01T00:00:00.000Z' }), { code: 'approval-before-version' });
  assert.equal((await approval(v, { decision: 'changes_requested' })).decision, 'changes_requested');
});

test('on-chain memo contains only a namespaced opaque commitment', async () => {
  const v = await version(); const a = await approval(v);
  assert.equal(memoForVersion(v), `versionpass:v1:v:${v.versionId}`);
  assert.equal(memoForApproval(a), `versionpass:v1:a:${a.approvalId}`);
  assert.equal(memoForVersion(v).includes(v.fileSha256), false);
  assert.equal(memoForVersion(v).includes(v.expectedReviewerPublicKey), false);
});

test('synthetic successful RPC snapshots pass only as scoped RPC observations', async () => {
  const v = await version(); const a = await approval(v);
  for (const [record, parent] of [[v, undefined], [a, v]]) {
    const receipt = await verifyAnchorObservation(observation(record, parent));
    assert.equal(receipt.state, 'rpc-verified'); assert.equal(receipt.network, NETWORK);
    assert.equal(receipt.trust, 'fresh-rpc-response-required');
    assert.match(receipt.explorerUrl, /\?cluster=devnet$/);
  }
});

test('chain verification refuses pending, failed, unavailable and conflicting slots', async () => {
  const initial = observation(await version());
  for (const mutate of [
    x => { x.status = null; }, x => { x.transaction = null; },
    x => { x.status.confirmationStatus = 'confirmed'; }, x => { x.status.confirmationStatus = 'processed'; },
    x => { x.status.err = { InstructionError: [0, 'failed'] }; },
    x => { x.transaction.meta.err = { InstructionError: [0, 'failed'] }; },
    x => { delete x.transaction.meta.err; }, x => { x.status.slot++; }
  ]) { const input = copy(initial); mutate(input); await assert.rejects(verifyAnchorObservation(input)); }
});

test('chain verification binds actual signer and transaction signature', async () => {
  const initial = observation(await version());
  for (const mutate of [
    x => { x.signerPublicKey = other; }, x => { x.transaction.transaction.signatures[0] = '2'.repeat(64); },
    x => { x.transaction.transaction.message.accountKeys[0].signer = false; },
    x => { x.transaction.transaction.message.accountKeys[0].pubkey = other; },
    x => { x.signature = 'invalid 123'; }
  ]) { const input = copy(initial); mutate(input); await assert.rejects(verifyAnchorObservation(input)); }
});

test('chain verification rejects wrong memo/program, extra transfer and mainnet lookalikes', async () => {
  const initial = observation(await version());
  for (const mutate of [
    x => { x.rpcUrl = 'https://api.mainnet-beta.solana.com'; },
    x => { x.rpcUrl = 'https://api.devnet.solana.com.attacker.invalid'; },
    x => { x.transaction.transaction.message.instructions[0].parsed += ' extra'; },
    x => { x.transaction.transaction.message.instructions[0].programId = creator; },
    x => { x.transaction.transaction.message.instructions.push({ programId: creator, parsed: {} }); }
  ]) { const input = copy(initial); mutate(input); await assert.rejects(verifyAnchorObservation(input)); }
});

test('approval anchor cannot reuse version memo or a foreign reviewer', async () => {
  const v = await version(); const a = await approval(v); const input = observation(a, v);
  input.transaction.transaction.message.instructions[0].parsed = memoForVersion(v);
  await assert.rejects(verifyAnchorObservation(input), { code: 'memo-mismatch' });
  const foreign = observation(a, v); foreign.signerPublicKey = creator;
  await assert.rejects(verifyAnchorObservation(foreign), { code: 'wrong-anchor-signer' });
});

test('demo is deterministic synthetic data, unanchored, with a visibly newer unapproved version', async () => {
  const demo = await createDemoWorkspace();
  assert.equal(demo.mode, 'synthetic-demo'); assert.deepEqual(demo.anchors, []);
  assert.equal((await validateVersionChain(demo.versions)).length, 2);
  assert.equal((await verifyFile(demo.versions[0], demo.files[0])).matches, true);
  assert.equal((await verifyFile(demo.versions[0], demo.files[1])).matches, false);
  assert.equal((await verifyApproval(demo.approvals[0], demo.versions[0])).decision, 'approved');
  await assert.rejects(verifyApproval(demo.approvals[0], demo.versions[1]), { code: 'approval-wrong-version' });
  assert.equal(Object.hasOwn(demo, 'signature'), false);
});
