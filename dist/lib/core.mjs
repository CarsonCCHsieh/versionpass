/**
 * VERSIONPASS browser-local domain core. No RPC, storage, wallet or file upload.
 * SHA-256 binds a version to bytes and its designated reviewer; approval is a
 * separate immutable record. Creating it does not prove a human action/identity.
 * Chain observations must come from fresh getTransaction/getSignatureStatuses
 * calls by the adapter. A JSON import is never independent chain evidence.
 * Verification trusts the named devnet RPC; this is not an offline consensus or
 * raw Ed25519 signature verifier. Client timestamps are claims, not chain time.
 * Sources: https://www.solana-program.com/docs/memo
 * https://solana.com/docs/rpc/http/gettransaction
 * https://solana.com/docs/rpc/http/getsignaturestatuses
 * https://solana.com/docs/rpc/json-structures
 */

export const NETWORK = 'solana-devnet';
export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const encoder = new TextEncoder();
const VERSION_KEYS = ['kind', 'schema', 'network', 'projectId', 'ordinal', 'previousVersionId', 'fileSha256', 'fileBytes', 'creatorPublicKey', 'expectedReviewerPublicKey', 'createdAt', 'nonce', 'versionId'];
const APPROVAL_KEYS = ['kind', 'schema', 'network', 'versionId', 'reviewerPublicKey', 'decision', 'createdAt', 'nonce', 'approvalId'];

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function object(value, code = 'invalid-object') {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
}
function keys(value, expected) {
  object(value);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail('unexpected-fields');
}
function hex(value, id = false) { if (typeof value !== 'string' || !(id ? ID : HEX).test(value)) fail(id ? 'invalid-id' : 'invalid-hash'); }
function integer(value, min, max, code) { if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) fail(code); }
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) fail('invalid-time');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail('invalid-time');
}
function decodeBase58(value, limit = 128) {
  if (typeof value !== 'string' || value.length < 1 || value.length > limit) fail('invalid-base58');
  let number = 0n;
  for (const char of value) { const digit = B58.indexOf(char); if (digit < 0) fail('invalid-base58'); number = number * 58n + BigInt(digit); }
  const bytes = [];
  while (number > 0n) { bytes.push(Number(number & 255n)); number >>= 8n; }
  bytes.reverse();
  let zeros = 0;
  while (value[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}
function publicKey(value) { if (decodeBase58(value, 44).length !== 32) fail('invalid-public-key'); }
function signatureValue(value) { if (decodeBase58(value, 88).length !== 64) fail('invalid-signature'); }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  object(value, 'non-json-value');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function payload(record, digestKey) { const copy = { ...record }; delete copy[digestKey]; return copy; }
async function digestRecord(record, digestKey) { return hashBytes(encoder.encode(canonical(payload(record, digestKey)))); }

export function randomId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }

export async function hashBytes(input) {
  let bytes;
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else fail('invalid-bytes');
  if (bytes.byteLength > MAX_FILE_BYTES) fail('file-too-large');
  // Own the snapshot: callers cannot mutate the hashed buffer while digest waits.
  const result = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashFile(file) {
  if (!(file instanceof Blob)) fail('invalid-file');
  integer(file.size, 0, MAX_FILE_BYTES, 'file-too-large');
  return Object.freeze({ sha256: await hashBytes(await file.arrayBuffer()), bytes: file.size });
}

function versionShape(record) {
  keys(record, VERSION_KEYS);
  if (record.kind !== 'versionpass.version' || record.schema !== 1 || record.network !== NETWORK) fail('invalid-version-kind');
  hex(record.projectId, true); hex(record.nonce, true); hex(record.versionId); hex(record.fileSha256);
  integer(record.ordinal, 1, 10000, 'invalid-ordinal');
  integer(record.fileBytes, 0, MAX_FILE_BYTES, 'invalid-file-size');
  if (record.ordinal === 1 ? record.previousVersionId !== null : !HEX.test(record.previousVersionId ?? '')) fail('invalid-parent');
  if (record.previousVersionId !== null && typeof record.previousVersionId !== 'string') fail('invalid-parent');
  publicKey(record.creatorPublicKey); publicKey(record.expectedReviewerPublicKey); timestamp(record.createdAt);
}

export async function createVersion(input) {
  object(input);
  const allowed = ['projectId', 'ordinal', 'fileSha256', 'fileBytes', 'creatorPublicKey', 'expectedReviewerPublicKey', 'previousVersionId', 'createdAt', 'nonce'];
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('unexpected-fields');
  const record = {
    kind: 'versionpass.version', schema: 1, network: NETWORK,
    projectId: input.projectId, ordinal: input.ordinal,
    previousVersionId: input.previousVersionId ?? null,
    fileSha256: input.fileSha256, fileBytes: input.fileBytes,
    creatorPublicKey: input.creatorPublicKey, expectedReviewerPublicKey: input.expectedReviewerPublicKey,
    createdAt: input.createdAt ?? new Date().toISOString(), nonce: input.nonce ?? randomId(), versionId: '0'.repeat(64)
  };
  versionShape(record);
  record.versionId = await digestRecord(record, 'versionId');
  return Object.freeze(record);
}

export async function verifyVersion(record) {
  versionShape(record);
  const copy = { ...record };
  if (await digestRecord(copy, 'versionId') !== copy.versionId) fail('version-tampered');
  return Object.freeze(copy);
}

export async function verifyFile(version, file) {
  const checked = await verifyVersion(version);
  const actual = await hashFile(file);
  return Object.freeze({ matches: actual.sha256 === checked.fileSha256 && actual.bytes === checked.fileBytes,
    expectedSha256: checked.fileSha256, actualSha256: actual.sha256, expectedBytes: checked.fileBytes, actualBytes: actual.bytes });
}

export async function validateVersionChain(versions) {
  if (!Array.isArray(versions) || versions.length > 200) fail('invalid-chain');
  const checked = [];
  for (const item of versions) {
    const version = await verifyVersion(item);
    const previous = checked.at(-1);
    if (version.ordinal !== checked.length + 1 || (previous && (version.projectId !== previous.projectId || version.creatorPublicKey !== previous.creatorPublicKey || version.previousVersionId !== previous.versionId || version.createdAt < previous.createdAt))) fail('broken-version-chain');
    checked.push(version);
  }
  return Object.freeze(checked);
}

function approvalShape(record) {
  keys(record, APPROVAL_KEYS);
  if (record.kind !== 'versionpass.approval' || record.schema !== 1 || record.network !== NETWORK) fail('invalid-approval-kind');
  hex(record.versionId); hex(record.approvalId); hex(record.nonce, true);
  publicKey(record.reviewerPublicKey); timestamp(record.createdAt);
  if (!['approved', 'changes_requested'].includes(record.decision)) fail('invalid-decision');
}

export async function createApproval(input) {
  object(input);
  if (Object.keys(input).some(key => !['version', 'reviewerPublicKey', 'decision', 'createdAt', 'nonce'].includes(key))) fail('unexpected-fields');
  const version = await verifyVersion(input.version);
  const record = { kind: 'versionpass.approval', schema: 1, network: NETWORK, versionId: version.versionId,
    reviewerPublicKey: input.reviewerPublicKey, decision: input.decision,
    createdAt: input.createdAt ?? new Date().toISOString(), nonce: input.nonce ?? randomId(), approvalId: '0'.repeat(64) };
  approvalShape(record);
  if (record.reviewerPublicKey !== version.expectedReviewerPublicKey) fail('wrong-reviewer');
  if (record.createdAt < version.createdAt) fail('approval-before-version');
  record.approvalId = await digestRecord(record, 'approvalId');
  return Object.freeze(record);
}

export async function verifyApproval(record, version) {
  approvalShape(record);
  const checkedVersion = await verifyVersion(version);
  const copy = { ...record };
  if (copy.versionId !== checkedVersion.versionId) fail('approval-wrong-version');
  if (copy.reviewerPublicKey !== checkedVersion.expectedReviewerPublicKey) fail('wrong-reviewer');
  if (copy.createdAt < checkedVersion.createdAt) fail('approval-before-version');
  if (await digestRecord(copy, 'approvalId') !== copy.approvalId) fail('approval-tampered');
  return Object.freeze(copy);
}

export function memoForVersion(version) { versionShape(version); return `versionpass:v1:v:${version.versionId}`; }
export function memoForApproval(approval) { approvalShape(approval); return `versionpass:v1:a:${approval.approvalId}`; }

/**
 * Adapter supplies raw getTransaction(encoding=jsonParsed, commitment=finalized)
 * result and the matching getSignatureStatuses(...searchTransactionHistory=true)
 * value[0]. For approvals, additionally pass `version` to validate its binding.
 * Do not call this on cached/imported observations and label them freshly checked.
 */
export async function verifyAnchorObservation(input) {
  object(input);
  const { record, signature, signerPublicKey, transaction, status, rpcUrl, observedAt, version } = input;
  if (rpcUrl !== DEVNET_RPC && rpcUrl !== `${DEVNET_RPC}/`) fail('wrong-network-rpc');
  timestamp(observedAt); publicKey(signerPublicKey); signatureValue(signature);
  let checked, memo, expectedSigner;
  if (record?.kind === 'versionpass.version') {
    checked = await verifyVersion(record); memo = memoForVersion(checked); expectedSigner = checked.creatorPublicKey;
  } else if (record?.kind === 'versionpass.approval') {
    checked = await verifyApproval(record, version); memo = memoForApproval(checked); expectedSigner = checked.reviewerPublicKey;
  } else fail('invalid-anchor-record');
  if (signerPublicKey !== expectedSigner) fail('wrong-anchor-signer');
  object(transaction, 'transaction-unavailable'); object(status, 'status-unavailable');
  if (status.confirmationStatus !== 'finalized' || status.err !== null || transaction.meta?.err !== null) fail('transaction-not-finalized-success');
  integer(transaction.slot, 0, Number.MAX_SAFE_INTEGER, 'invalid-slot');
  if (status.slot !== transaction.slot) fail('slot-mismatch');
  const tx = transaction.transaction;
  if (!tx || !Array.isArray(tx.signatures) || tx.signatures[0] !== signature) fail('signature-mismatch');
  const accounts = tx.message?.accountKeys;
  if (!Array.isArray(accounts) || !accounts.some(account => account?.pubkey === signerPublicKey && account.signer === true)) fail('transaction-missing-signer');
  const instructions = tx.message?.instructions;
  // The app anchors one memo only. Reject transfers, extra memos or unrelated CPI
  // instead of endorsing an arbitrary transaction that happens to contain a memo.
  if (!Array.isArray(instructions) || instructions.length !== 1 || instructions[0]?.programId !== MEMO_PROGRAM_ID) fail('unexpected-instructions');
  const instruction = instructions[0];
  let actualMemo;
  if (typeof instruction.parsed === 'string') actualMemo = instruction.parsed;
  else if (typeof instruction.data === 'string') {
    try { actualMemo = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase58(instruction.data, 256)); }
    catch { fail('invalid-memo-data'); }
  } else fail('invalid-memo-data');
  if (actualMemo !== memo) fail('memo-mismatch');
  if (transaction.blockTime !== null && transaction.blockTime !== undefined) integer(transaction.blockTime, 0, Number.MAX_SAFE_INTEGER, 'invalid-block-time');
  return Object.freeze({ kind: 'versionpass.rpc-observation', schema: 1, state: 'rpc-verified', network: NETWORK,
    recordId: checked.versionId && checked.kind === 'versionpass.version' ? checked.versionId : checked.approvalId,
    recordKind: checked.kind, signature, signerPublicKey, memo, slot: transaction.slot,
    blockTime: transaction.blockTime ?? null, confirmationStatus: 'finalized', rpcUrl: DEVNET_RPC, observedAt,
    explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`, trust: 'fresh-rpc-response-required' });
}

/** Synthetic bytes and records only; no fake transaction signature or anchor. */
export async function createDemoWorkspace() {
  const projectId = 'e4'.repeat(16);
  // Public synthetic test addresses, not usable private signing keys or identities.
  const creatorPublicKey = '11111111111111111111111111111111';
  const expectedReviewerPublicKey = MEMO_PROGRAM_ID;
  const files = [new Blob(['VERSIONPASS synthetic storyboard v1\nScene: A paper lantern.\n']), new Blob(['VERSIONPASS synthetic storyboard v2\nScene: Two paper lanterns.\n'])];
  const firstHash = await hashFile(files[0]);
  const secondHash = await hashFile(files[1]);
  const first = await createVersion({ projectId, ordinal: 1, fileSha256: firstHash.sha256, fileBytes: firstHash.bytes,
    creatorPublicKey, expectedReviewerPublicKey, createdAt: '2026-11-02T00:00:00.000Z', nonce: '01'.repeat(16) });
  const second = await createVersion({ projectId, ordinal: 2, previousVersionId: first.versionId,
    fileSha256: secondHash.sha256, fileBytes: secondHash.bytes, creatorPublicKey, expectedReviewerPublicKey,
    createdAt: '2026-11-02T00:10:00.000Z', nonce: '02'.repeat(16) });
  const approval = await createApproval({ version: first, reviewerPublicKey: expectedReviewerPublicKey, decision: 'approved',
    createdAt: '2026-11-02T00:05:00.000Z', nonce: '03'.repeat(16) });
  return Object.freeze({ mode: 'synthetic-demo', projectId, versions: Object.freeze([first, second]),
    approvals: Object.freeze([approval]), files: Object.freeze(files), anchors: Object.freeze([]) });
}
