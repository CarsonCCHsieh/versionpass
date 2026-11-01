import {
  AccountRole, address, appendTransactionMessageInstruction, createSolanaRpc,
  createTransactionMessage, generateKeyPairSigner,
  getBase64EncodedWireTransaction, getSignatureFromTransaction,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners
} from './solana-vendor.mjs';
import { memoForVersion, memoForApproval, verifyVersion, verifyApproval, verifyAnchorObservation } from './core.mjs';

export const RPC_URL = 'https://api.devnet.solana.com';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const encoder = new TextEncoder();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Kit returns bigint/readonly values and string addresses. The domain core
// consumes JSON-RPC-shaped safe integers; reject overflow instead of rounding.
function rpcJson(value) {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('RPC integer exceeds the local verifier range.');
    return Number(value);
  }
  if (Array.isArray(value)) return value.map(rpcJson);
  if (value && typeof value === 'object') {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Unexpected RPC value.');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rpcJson(item)]));
  }
  return value;
}

function httpStatus(error) {
  for (let level = 0, item = error; item && level < 5; level++, item = item.cause) {
    const status = item.context?.statusCode ?? item.status;
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return null;
}

export function explorerUrl(signature) {
  return 'https://explorer.solana.com/tx/' + encodeURIComponent(signature) + '?cluster=devnet';
}

/**
 * One memory-only devnet session. Dependencies are injectable for offline tests,
 * not configurable through the UI. Private keys/serialized transactions are
 * never returned, persisted or logged. Closing the page discards the signers.
 * A signed request is retained before its single send. Unknown delivery is only
 * reconciled by signature; it is never automatically re-created or re-posted.
 */
export function createDevnetAdapter({
  createConnection = () => createSolanaRpc(RPC_URL),
  createIdentity = () => generateKeyPairSigner(false), wait = delay, statusAttempts = 16
} = {}) {
  if (!Number.isInteger(statusAttempts) || statusAttempts < 1 || statusAttempts > 16) throw new Error('Invalid finality polling bound.');
  let connection, identities, identityWork, faucetWork, faucetAttempted = false, faucetSignature;
  const pending = new Map();
  const inFlight = new Map();

  // Kit's ordinary HTTP transport does not automatically retry. Each explicit
  // request gets its own bounded lifetime; no send-and-confirm/airdrop factory
  // may introduce an implicit resend or subscription behind this boundary.
  const send = request => request.send({ abortSignal: AbortSignal.timeout(20000) });

  async function getDevnet() {
    connection ||= createConnection();
    if (await send(connection.getGenesisHash()) !== DEVNET_GENESIS) throw new Error('The RPC is not Solana devnet. No transaction was sent.');
    return connection;
  }

  async function createTestIdentities() {
    if (!identityWork) identityWork = (async () => {
      await getDevnet();
      const [creator, reviewer] = await Promise.all([createIdentity(), createIdentity()]);
      identities = { creator, reviewer };
      return Object.freeze({ creator: creator.address, reviewer: reviewer.address });
    })();
    return identityWork;
  }

  async function finalizedStatus(signature) {
    const rpc = await getDevnet();
    for (let attempt = 0; attempt < statusAttempts; attempt++) {
      const status = rpcJson((await send(rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0]);
      if (status?.confirmationStatus === 'finalized') return status;
      if (attempt < statusAttempts - 1) await wait(1500);
    }
    return null;
  }

  async function requestTestCredits() {
    if (!identities) throw new Error('Create the temporary test identities first.');
    if (faucetWork) return faucetWork;
    faucetWork = (async () => {
      const rpc = await getDevnet();
      if ((await send(rpc.getBalance(identities.creator.address, { commitment: 'finalized' }))).value >= 100000n) return { funded: true, requested: false };
      if (faucetAttempted) return { funded: false, requested: false, signature: faucetSignature ?? null, reason: 'faucet-already-attempted' };
      // Consume the attempt before awaiting: a lost response cannot cause a
      // duplicate faucet request. No paid fallback or retry on a 429 response.
      faucetAttempted = true;
      try {
        faucetSignature = await send(rpc.requestAirdrop(identities.creator.address, 50000000n, { commitment: 'finalized' }));
        const status = await finalizedStatus(faucetSignature);
        return { funded: !!status && status.err === null, requested: true, signature: faucetSignature,
          reason: !status ? 'awaiting-finality' : status.err === null ? null : 'transaction-failed' };
      } catch (error) {
        return { funded: false, requested: true, signature: faucetSignature ?? null,
          reason: 'faucet-unavailable', httpStatus: httpStatus(error) };
      }
    })();
    try { return await faucetWork; } finally { faucetWork = undefined; }
  }

  function receipt(record, signature, state = 'pending', reason = 'awaiting-finality') {
    return { state, recordId: record.kind === 'versionpass.version' ? record.versionId : record.approvalId,
      signature, rpcUrl: RPC_URL, explorer: explorerUrl(signature), reason };
  }

  async function checkRecord(record, signature, version) {
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) throw new Error('Invalid transaction signature.');
    // Validate untrusted imported records before querying or rendering an anchor.
    if (record?.kind === 'versionpass.version') await verifyVersion(record);
    else if (record?.kind === 'versionpass.approval') await verifyApproval(record, version);
    else throw new Error('Unsupported record type.');
    const rpc = await getDevnet();
    let status, transaction;
    try {
      status = rpcJson((await send(rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0]);
      if (!status || status.confirmationStatus !== 'finalized') return receipt(record, signature);
      if (status.err !== null) return receipt(record, signature, 'failed', 'transaction-failed');
      transaction = await send(rpc.getTransaction(signature, {
        encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0
      }));
    } catch { return receipt(record, signature, 'pending', 'rpc-unavailable'); }
    if (!transaction) return receipt(record, signature, 'pending', 'transaction-unavailable');
    const observation = await verifyAnchorObservation({ record, signature,
      signerPublicKey: record.kind === 'versionpass.version' ? record.creatorPublicKey : record.reviewerPublicKey,
      transaction: rpcJson(transaction), status, rpcUrl: RPC_URL, observedAt: new Date().toISOString(), version });
    return { ...observation, explorer: explorerUrl(signature) };
  }

  async function anchorRecord(record, kind, version) {
    if (!identities || !['version', 'approval'].includes(kind)) throw new Error('A temporary devnet session and a supported record type are required.');
    const checked = kind === 'version' ? await verifyVersion(record) : await verifyApproval(record, version);
    const actor = kind === 'version' ? identities.creator : identities.reviewer;
    const expected = kind === 'version' ? checked.creatorPublicKey : checked.reviewerPublicKey;
    if (actor.address !== expected) throw new Error('This browser session does not hold the record signer.');
    const id = kind === 'version' ? checked.versionId : checked.approvalId;
    if (inFlight.has(id)) return inFlight.get(id);
    if (pending.has(id)) return checkRecord(checked, pending.get(id), version);
    const work = (async () => {
      const rpc = await getDevnet();
      if ((await send(rpc.getBalance(identities.creator.address, { commitment: 'finalized' }))).value < 100000n) throw new Error('Free test credits are needed. No real-money wallet or payment is used.');
      const block = (await send(rpc.getLatestBlockhash({ commitment: 'finalized' }))).value;
      const memo = kind === 'version' ? memoForVersion(checked) : memoForApproval(checked);
      let message = createTransactionMessage({ version: 'legacy' });
      message = setTransactionMessageFeePayerSigner(identities.creator, message);
      message = setTransactionMessageLifetimeUsingBlockhash(block, message);
      message = appendTransactionMessageInstruction({
        accounts: [{ address: actor.address, role: AccountRole.READONLY_SIGNER, signer: actor }],
        programAddress: MEMO_PROGRAM, data: encoder.encode(memo)
      }, message);
      // The approval's designated reviewer is an actual required signer, in
      // addition to the creator fee payer. A public address alone cannot sign.
      const transaction = await signTransactionMessageWithSigners(message);
      const wire = getBase64EncodedWireTransaction(transaction);
      const signature = getSignatureFromTransaction(transaction);
      pending.set(id, signature);
      try {
        const returnedSignature = await send(rpc.sendTransaction(wire, {
          encoding: 'base64', skipPreflight: false, maxRetries: 0n, preflightCommitment: 'finalized'
        }));
        if (returnedSignature !== signature) return receipt(checked, signature, 'pending', 'submission-unconfirmed');
        const status = await finalizedStatus(signature);
        if (!status) return receipt(checked, signature);
        if (status.err !== null) return receipt(checked, signature, 'failed', 'transaction-failed');
      } catch { return receipt(checked, signature, 'pending', 'submission-unconfirmed'); }
      return checkRecord(checked, signature, version);
    })();
    inFlight.set(id, work);
    try { return await work; } finally { inFlight.delete(id); }
  }

  return Object.freeze({ getDevnet, createTestIdentities, requestTestCredits, anchorRecord, checkRecord });
}

const session = createDevnetAdapter();
export const { getDevnet, createTestIdentities, requestTestCredits, anchorRecord, checkRecord } = session;
