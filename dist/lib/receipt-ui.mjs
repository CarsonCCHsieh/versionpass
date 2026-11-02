// UI receipt boundaries and status semantics. No wallet, RPC, storage or signing.
import { validateVersionChain, verifyApproval } from './core.mjs';

export const MAX_RECEIPT_BYTES = 256 * 1024;
export const MAX_RECEIPT_VERSIONS = 100;
const BUNDLE_KEYS = ['kind', 'schema', 'network', 'versions', 'approvals', 'anchors'];
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
function fail() { throw new Error('invalid-receipt'); }
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}

export async function validateReceiptBundle(receipt) {
  exactKeys(receipt, BUNDLE_KEYS);
  if (receipt.kind !== 'versionpass.receipt-bundle' || receipt.schema !== 1 || receipt.network !== 'solana-devnet' ||
      !Array.isArray(receipt.versions) || !receipt.versions.length || receipt.versions.length > MAX_RECEIPT_VERSIONS ||
      !Array.isArray(receipt.approvals) || receipt.approvals.length > MAX_RECEIPT_VERSIONS ||
      !Array.isArray(receipt.anchors) || receipt.anchors.length > 2 * MAX_RECEIPT_VERSIONS) fail();
  const versions = await validateVersionChain(receipt.versions);
  const approvals = [];
  const reviewedVersions = new Set();
  for (const record of receipt.approvals) {
    // A bundle has one unambiguous review decision per version. Do not select a
    // convenient old approval while ignoring a conflicting review record.
    if (reviewedVersions.has(record?.versionId)) fail();
    const version = versions.find(item => item.versionId === record?.versionId);
    approvals.push(await verifyApproval(record, version));
    reviewedVersions.add(record.versionId);
  }
  const ids = new Set([...versions.map(item => item.versionId), ...approvals.map(item => item.approvalId)]);
  const anchoredIds = new Set();
  const signatures = new Set();
  const anchors = receipt.anchors.map(anchor => {
    exactKeys(anchor, ['recordId', 'signature']);
    if (!ids.has(anchor.recordId) || typeof anchor.signature !== 'string' || !SIGNATURE.test(anchor.signature) ||
        anchoredIds.has(anchor.recordId) || signatures.has(anchor.signature)) fail();
    anchoredIds.add(anchor.recordId); signatures.add(anchor.signature);
    return Object.freeze({ recordId: anchor.recordId, signature: anchor.signature });
  });
  // Explicit reconstruction never carries imported extra fields or observations.
  return Object.freeze({ kind: 'versionpass.receipt-bundle', schema: 1, network: 'solana-devnet',
    versions, approvals: Object.freeze(approvals), anchors: Object.freeze(anchors) });
}

export async function parseReceiptFile(file) {
  if (!(file instanceof Blob) || file.size > MAX_RECEIPT_BYTES) fail();
  return validateReceiptBundle(JSON.parse(await file.text()));
}

export async function serializeReceiptBundle(bundle) {
  const checked = await validateReceiptBundle(bundle);
  const serialized = JSON.stringify(checked, null, 2);
  if (new TextEncoder().encode(serialized).byteLength > MAX_RECEIPT_BYTES) fail();
  return serialized;
}

export function upsertObservation(anchors, record, observation) {
  const recordId = record.approvalId || record.versionId;
  if (!observation || !['rpc-verified', 'pending', 'failed'].includes(observation.state) ||
      typeof observation.signature !== 'string' || !SIGNATURE.test(observation.signature) ||
      (observation.recordId !== undefined && observation.recordId !== recordId)) fail();
  return [...anchors.filter(item => item.recordId !== recordId), Object.freeze({ ...observation, recordId })];
}

export function verificationPlan(receipt) {
  const version = receipt.versions.at(-1);
  const approval = receipt.approvals.find(item => item.versionId === version.versionId);
  return { version, approval, records: [version, ...(approval ? [approval] : [])] };
}

export function liveSummary(plan, observations) {
  if (observations.length !== plan.records.length || observations.some((observation, index) =>
    observation.state !== 'rpc-verified' || observation.recordId !== (plan.records[index].approvalId || plan.records[index].versionId))) return 'unverified';
  if (!plan.approval) return 'delivery-only';
  return plan.approval.decision === 'approved' ? 'approved' : 'changes-requested';
}

export function balanceStatusKey(result) {
  if (result?.state === 'funded' && result.funded === true) return 'creditsReady';
  if (result?.state === 'unfunded' && result.funded === false) return 'creditsNeeded';
  return 'creditsUnknown';
}
