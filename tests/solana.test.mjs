import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { getAddressEncoder } from '@solana/addresses';
import { getCompiledTransactionMessageDecoder } from '@solana/transaction-messages';
import { getSignatureFromTransaction, getTransactionDecoder } from '@solana/transactions';
import { createDevnetAdapter, DEVNET_GENESIS } from '../dist/lib/solana.mjs';
import { createVersion, createApproval, hashBytes, memoForVersion, memoForApproval, MEMO_PROGRAM_ID } from '../dist/lib/core.mjs';

// Run the built browser adapter under Node's real WebCrypto. This supplies the
// secure-context flag only; these offline tests are not browser/UI evidence.
globalThis.isSecureContext = true;

const fixtures = new Set();
afterEach(() => {
  // Adapter outage handling must never swallow a fake RPC contract assertion.
  for (const state of fixtures) assert.deepEqual(state.contractErrors, []);
  fixtures.clear();
});

async function fixture(options = {}) {
  const state = { sends: 0, airDrops: 0, statusReads: 0, parsedReads: 0,
    final: true, calls: [], contractErrors: [], ...options };
  fixtures.add(state);
  async function contract(check) {
    try { return await check(); }
    catch (error) { state.contractErrors.push(error.message); throw error; }
  }
  const method = (name, check, perform) => (...args) => ({
    send: async config => {
      await contract(() => {
        assert.ok(config?.abortSignal instanceof AbortSignal, name + ' needs a bounded request signal');
        assert.equal(config.abortSignal.aborted, false);
        check(...args);
      });
      state.calls.push({ name, args, signal: config.abortSignal });
      return perform(...args);
    }
  });

  async function inspectWire(base64wire) {
    assert.equal(typeof base64wire, 'string');
    const decoded = getTransactionDecoder().decode(Buffer.from(base64wire, 'base64'));
    const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
    const record = state.record;
    const creator = record.kind === 'versionpass.version' ? record.creatorPublicKey : state.version.creatorPublicKey;
    const actor = record.kind === 'versionpass.version' ? record.creatorPublicKey : record.reviewerPublicKey;
    const expectedSigners = record.kind === 'versionpass.version' ? [creator] : [creator, actor];
    const expectedMemo = record.kind === 'versionpass.version' ? memoForVersion(record) : memoForApproval(record);
    assert.equal(message.version, 'legacy');
    assert.equal(message.staticAccounts[0], creator, 'creator must pay the fee');
    assert.equal(message.header.numSignerAccounts, expectedSigners.length);
    assert.equal(message.header.numReadonlySignerAccounts, expectedSigners.length - 1);
    assert.deepEqual(new Set(message.staticAccounts), new Set([...expectedSigners, MEMO_PROGRAM_ID]));
    assert.deepEqual(Object.keys(decoded.signatures), expectedSigners);
    assert.equal(message.instructions.length, 1);
    const [instruction] = message.instructions;
    assert.equal(message.staticAccounts[instruction.programAddressIndex], MEMO_PROGRAM_ID);
    assert.deepEqual(Array.from(instruction.accountIndices ?? [], index => message.staticAccounts[index]), [actor]);
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(instruction.data), expectedMemo);
    for (const signer of expectedSigners) {
      const signature = decoded.signatures[signer];
      assert.equal(signature.length, 64);
      const key = await webcrypto.subtle.importKey('raw', Uint8Array.from(getAddressEncoder().encode(signer)),
        { name: 'Ed25519' }, false, ['verify']);
      assert.equal(await webcrypto.subtle.verify('Ed25519', key,
        Uint8Array.from(signature), Uint8Array.from(decoded.messageBytes)), true,
      'wire signature must verify against its required signer and exact message');
    }
    state.signature = getSignatureFromTransaction(decoded);
    state.signerCount = expectedSigners.length;
    state.wireMessage = message;
  }

  const rpc = {
    getGenesisHash: method('getGenesisHash', () => {}, () => state.genesis ?? DEVNET_GENESIS),
    getBalance: method('getBalance', (account, config) => {
      assert.equal(typeof account, 'string');
      assert.equal(account, state.ids.creator);
      assert.deepEqual(config, { commitment: 'finalized' });
    }, () => ({ context: { slot: 78n }, value: state.unfunded ? 0n : 50000000n })),
    requestAirdrop: method('requestAirdrop', (account, lamports, config) => {
      assert.equal(account, state.ids.creator);
      assert.equal(lamports, 50000000n);
      assert.deepEqual(config, { commitment: 'finalized' });
    }, () => {
      state.airDrops++;
      if (state.faucetError) throw state.faucetError;
      return '1'.repeat(64);
    }),
    getLatestBlockhash: method('getLatestBlockhash', config => {
      assert.deepEqual(config, { commitment: 'finalized' });
    }, () => ({ context: { slot: 78n }, value: {
      blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999n
    } })),
    sendTransaction: method('sendTransaction', (wire, config) => {
      assert.equal(typeof wire, 'string');
      assert.deepEqual(config, { encoding: 'base64', skipPreflight: false,
        maxRetries: 0n, preflightCommitment: 'finalized' });
    }, async wire => {
      state.sends++;
      await contract(() => inspectWire(wire));
      state.abortBeforeSendResponse?.();
      if (state.deliveryLost) throw new Error('Synthetic delivery response lost');
      return state.returnedWrongSignature ? '2'.repeat(64) : state.signature;
    }),
    getSignatureStatuses: method('getSignatureStatuses', (signatures, config) => {
      assert.equal(signatures.length, 1);
      assert.equal(typeof signatures[0], 'string');
      assert.deepEqual(config, { searchTransactionHistory: true });
    }, () => {
      state.statusReads++;
      if (state.statusError) throw new Error('Synthetic RPC unavailable');
      return { context: { slot: 78n }, value: [{ slot: 77n,
        confirmations: state.final ? null : 1n,
        confirmationStatus: state.final ? 'finalized' : 'confirmed',
        err: state.failed ? { InstructionError: [0n, 'InvalidArgument'] } : null }] };
    }),
    getTransaction: method('getTransaction', (signature, config) => {
      assert.equal(signature, state.signature);
      assert.deepEqual(config, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    }, signature => {
      state.parsedReads++;
      if (state.transactionMissing) return null;
      const record = state.record;
      const actor = record.kind === 'versionpass.version' ? record.creatorPublicKey : record.reviewerPublicKey;
      const message = state.wireMessage;
      const header = message.header;
      return { slot: state.overflow ? BigInt(Number.MAX_SAFE_INTEGER) + 1n : 77n, blockTime: 1793577600n,
        meta: { err: null, fee: 5000n, preBalances: [50000000n], postBalances: [49995000n] },
        transaction: { signatures: [signature], message: {
          accountKeys: message.staticAccounts.map((pubkey, index) => ({ pubkey,
            signer: index < header.numSignerAccounts && !(state.wrongSigner && pubkey === actor),
            writable: index < header.numSignerAccounts
              ? index < header.numSignerAccounts - header.numReadonlySignerAccounts
              : index < message.staticAccounts.length - header.numReadonlyNonSignerAccounts })),
          instructions: [{ programId: MEMO_PROGRAM_ID,
            parsed: state.wrongMemo ? 'unrelated' : new TextDecoder().decode(message.instructions[0].data) }]
        } } };
    })
  };
  const adapter = createDevnetAdapter({ createConnection: () => rpc, wait: async () => {}, statusAttempts: 1 });
  return { adapter, state };
}

async function prepare(fx) {
  const ids = await fx.adapter.createTestIdentities();
  fx.state.ids = ids;
  const record = await createVersion({ projectId: '56'.repeat(16), ordinal: 1,
    fileSha256: await hashBytes(new TextEncoder().encode('Synthetic VERSIONPASS test')),
    fileBytes: 26, creatorPublicKey: ids.creator, expectedReviewerPublicKey: ids.reviewer });
  fx.state.record = record;
  fx.state.version = record;
  return { ids, record };
}

test('Kit-built legacy memo has a real Ed25519 signature, correct actor/payer, bigint reads and bounded RPC signals', async () => {
  const fx = await fixture(); const { record } = await prepare(fx);
  const result = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(result.state, 'rpc-verified'); assert.equal(result.slot, 77);
  assert.equal(result.signature, fx.state.signature);
  assert.equal(fx.state.sends, 1); assert.equal(fx.state.signerCount, 1);
  assert.equal(Object.hasOwn(result, 'secretKey'), false);
  for (const name of ['getGenesisHash', 'getBalance', 'getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses', 'getTransaction']) {
    assert.ok(fx.state.calls.some(call => call.name === name && call.signal instanceof AbortSignal), name);
  }
});

test('duplicate concurrent anchor and later clicks keep the same signature with only one send', async () => {
  const fx = await fixture(); const { record } = await prepare(fx);
  const [first, second] = await Promise.all([fx.adapter.anchorRecord(record, 'version'), fx.adapter.anchorRecord(record, 'version')]);
  const third = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(first.state, 'rpc-verified'); assert.equal(second.state, 'rpc-verified'); assert.equal(third.state, 'rpc-verified');
  assert.equal(first.signature, second.signature); assert.equal(first.signature, third.signature);
  assert.equal(fx.state.sends, 1); assert.ok(fx.state.statusReads >= 3);
});

test('response loss retains locally derived signature and reconciles without re-posting', async () => {
  const fx = await fixture({ deliveryLost: true }); const { record } = await prepare(fx);
  const first = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(first.state, 'pending'); assert.equal(first.reason, 'submission-unconfirmed');
  assert.equal(first.signature, fx.state.signature); assert.equal(first.recordId, record.versionId);
  fx.state.deliveryLost = false;
  const recovered = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(recovered.state, 'rpc-verified'); assert.equal(recovered.signature, first.signature);
  assert.equal(fx.state.sends, 1);
});

test('20-second request deadline reaches send and an aborted response remains read-only recoverable', async () => {
  const fx = await fixture(); const { record } = await prepare(fx);
  const controller = new AbortController();
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  const durations = [];
  fx.state.abortBeforeSendResponse = () => {
    controller.abort(new DOMException('Synthetic request deadline', 'TimeoutError'));
    fx.state.calls.findLast(call => call.name === 'sendTransaction').signal.throwIfAborted();
  };
  let pending;
  Object.defineProperty(AbortSignal, 'timeout', { ...descriptor, value: milliseconds => {
    durations.push(milliseconds);
    return controller.signal;
  } });
  try { pending = await fx.adapter.anchorRecord(record, 'version'); }
  finally { Object.defineProperty(AbortSignal, 'timeout', descriptor); }
  assert.ok(durations.length >= 4);
  assert.ok(durations.every(milliseconds => milliseconds === 20000));
  assert.equal(pending.state, 'pending'); assert.equal(pending.reason, 'submission-unconfirmed');
  assert.equal(pending.signature, fx.state.signature);
  delete fx.state.abortBeforeSendResponse;
  const recovered = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(recovered.state, 'rpc-verified'); assert.equal(recovered.signature, pending.signature);
  assert.equal(fx.state.sends, 1);
});

test('a mismatched send response cannot replace the derived signature or trigger another send', async () => {
  const fx = await fixture({ returnedWrongSignature: true }); const { record } = await prepare(fx);
  const first = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(first.state, 'pending'); assert.equal(first.reason, 'submission-unconfirmed');
  assert.equal(first.signature, fx.state.signature); assert.notEqual(first.signature, '2'.repeat(64));
  const recovered = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(recovered.state, 'rpc-verified'); assert.equal(recovered.signature, first.signature);
  assert.equal(fx.state.sends, 1);
});

test('confirmed and unavailable transactions stay pending until an explicit read-only recheck', async () => {
  const fx = await fixture({ final: false }); const { record } = await prepare(fx);
  const pending = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(pending.state, 'pending'); assert.equal(fx.state.parsedReads, 0);
  fx.state.final = true; fx.state.transactionMissing = true;
  const missing = await fx.adapter.checkRecord(record, pending.signature);
  assert.equal(missing.state, 'pending'); assert.equal(missing.reason, 'transaction-unavailable');
  fx.state.transactionMissing = false;
  assert.equal((await fx.adapter.checkRecord(record, pending.signature)).state, 'rpc-verified');
  assert.equal(fx.state.sends, 1);
});

test('read outage preserves signature, while wrong memo or missing actor signer is rejected', async () => {
  const fx = await fixture({ statusError: true }); const { record } = await prepare(fx);
  const pending = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(pending.state, 'pending'); assert.ok(pending.signature);
  const unavailable = await fx.adapter.checkRecord(record, pending.signature);
  assert.equal(unavailable.reason, 'rpc-unavailable'); assert.equal(unavailable.signature, pending.signature);
  fx.state.statusError = false; fx.state.wrongMemo = true;
  await assert.rejects(fx.adapter.checkRecord(record, pending.signature), { code: 'memo-mismatch' });
  fx.state.wrongMemo = false; fx.state.wrongSigner = true;
  await assert.rejects(fx.adapter.checkRecord(record, pending.signature), { code: 'transaction-missing-signer' });
  assert.equal(fx.state.sends, 1);
});

test('designated reviewer approval has two verified wire signatures and creator remains fee payer', async () => {
  const fx = await fixture(); const { ids, record: version } = await prepare(fx);
  const approval = await createApproval({ version, reviewerPublicKey: ids.reviewer, decision: 'approved' });
  fx.state.record = approval;
  const result = await fx.adapter.anchorRecord(approval, 'approval', version);
  assert.equal(result.state, 'rpc-verified'); assert.equal(result.recordId, approval.approvalId);
  assert.equal(fx.state.signerCount, 2); assert.equal(fx.state.sends, 1);
  assert.equal(fx.state.wireMessage.staticAccounts[0], ids.creator);
});

test('429 faucet is attempted once with bigint devnet credits and is never retried', async () => {
  const error = new Error('Synthetic rate limit'); error.context = { statusCode: 429 };
  const fx = await fixture({ unfunded: true, faucetError: error }); const { record } = await prepare(fx);
  const first = await fx.adapter.requestTestCredits();
  assert.equal(first.funded, false); assert.equal(first.httpStatus, 429);
  assert.equal(first.reason, 'faucet-unavailable');
  const second = await fx.adapter.requestTestCredits();
  assert.equal(second.reason, 'faucet-already-attempted'); assert.equal(second.requested, false);
  await assert.rejects(fx.adapter.anchorRecord(record, 'version'), /Free test credits/);
  assert.equal(fx.state.airDrops, 1); assert.equal(fx.state.sends, 0);
});

test('failed chain transaction stays failed and unsafe bigint cannot become verified', async () => {
  const fx = await fixture({ failed: true }); const { record } = await prepare(fx);
  const failed = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'transaction-failed');
  fx.state.failed = false; fx.state.overflow = true;
  await assert.rejects(fx.adapter.checkRecord(record, failed.signature), /verifier range/);
  assert.equal(fx.state.sends, 1);
});

test('wrong genesis blocks temporary identities and all faucet/anchor activity', async () => {
  const fx = await fixture({ genesis: 'wrong-network' });
  await assert.rejects(fx.adapter.createTestIdentities(), /not Solana devnet/);
  assert.equal(fx.state.airDrops, 0); assert.equal(fx.state.sends, 0);
  assert.deepEqual(fx.state.calls.map(call => call.name), ['getGenesisHash']);
});
