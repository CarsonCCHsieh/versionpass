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
    }, () => {
      if (state.balanceError) throw state.balanceError;
      return { context: { slot: 78n }, value: state.balance ?? (state.unfunded ? 0n : 50000000n) };
    }),
    requestAirdrop: () => {
      state.airDrops++;
      throw new Error('Automatic faucet requests must never be called.');
    },
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

test('balance checks need an existing identity and never create one implicitly', async () => {
  const fx = await fixture();
  await assert.rejects(fx.adapter.checkTestBalance(), /Create the temporary test identities first/);
  assert.deepEqual(fx.state.calls, []);
  assert.equal(fx.state.airDrops, 0); assert.equal(fx.state.sends, 0);
  assert.equal('requestTestCredits' in fx.adapter, false);
});

test('balance checks only read finalized devnet balance, including after manual funding', async () => {
  const fx = await fixture({ balance: 0n }); const { ids, record } = await prepare(fx);
  const results = await Promise.all([fx.adapter.checkTestBalance(), fx.adapter.checkTestBalance()]);
  assert.deepEqual(results[0], { state: 'unfunded', funded: false, balanceLamports: '0', minimumLamports: '100000' });
  assert.strictEqual(results[0], results[1]);
  assert.equal(fx.state.calls.filter(call => call.name === 'getBalance').length, 1);
  fx.state.balance = 99999n;
  assert.equal((await fx.adapter.checkTestBalance()).state, 'unfunded');
  await assert.rejects(fx.adapter.anchorRecord(record, 'version'), /Free test credits/);
  fx.state.balance = 100000n;
  assert.deepEqual(await fx.adapter.checkTestBalance(), {
    state: 'funded', funded: true, balanceLamports: '100000', minimumLamports: '100000'
  });
  assert.strictEqual(await fx.adapter.createTestIdentities(), ids, 'balance checks must retain the same memory-only identities');
  assert.notEqual(ids.creator, ids.reviewer);
  assert.deepEqual(Object.keys(ids).sort(), ['creator', 'reviewer']);
  assert.ok(Object.values(ids).every(value => typeof value === 'string'), 'identity results expose public addresses only');
  const fresh = await fixture();
  const freshIds = await fresh.adapter.createTestIdentities();
  assert.notEqual(freshIds.creator, ids.creator, 'a fresh adapter does not recover the discarded session identity');
  assert.notEqual(freshIds.reviewer, ids.reviewer);
  assert.ok(fx.state.calls.every(call => ['getGenesisHash', 'getBalance'].includes(call.name)));
  assert.equal(fx.state.airDrops, 0); assert.equal(fx.state.sends, 0);
});

test('balance RPC errors and a changed genesis remain unknown, never funded or confirmed zero', async () => {
  const fx = await fixture({ balanceError: new Error('Synthetic read outage') }); await prepare(fx);
  const unavailable = { state: 'unavailable', funded: null, balanceLamports: null, minimumLamports: '100000' };
  assert.deepEqual(await fx.adapter.checkTestBalance(), unavailable);
  fx.state.balanceError = null;
  fx.state.genesis = 'wrong-network';
  assert.deepEqual(await fx.adapter.checkTestBalance(), unavailable);
  assert.equal(fx.state.calls.filter(call => call.name === 'getBalance').length, 1, 'wrong genesis blocks the balance read');
  assert.equal(fx.state.airDrops, 0); assert.equal(fx.state.sends, 0);
  assert.ok(fx.state.calls.every(call => ['getGenesisHash', 'getBalance'].includes(call.name)));
});

test('invalid balance values stay unavailable without requesting tokens or sending transactions', async () => {
  const fx = await fixture({ balance: -1n }); await prepare(fx);
  assert.equal((await fx.adapter.checkTestBalance()).state, 'unavailable');
  fx.state.balance = 100000;
  assert.equal((await fx.adapter.checkTestBalance()).state, 'unavailable');
  assert.equal(fx.state.airDrops, 0); assert.equal(fx.state.sends, 0);
});

test('failed chain transaction stays failed and unsafe bigint cannot become verified', async () => {
  const fx = await fixture({ failed: true }); const { record } = await prepare(fx);
  const failed = await fx.adapter.anchorRecord(record, 'version');
  assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'transaction-failed');
  fx.state.failed = false; fx.state.overflow = true;
  await assert.rejects(fx.adapter.checkRecord(record, failed.signature), /verifier range/);
  assert.equal(fx.state.sends, 1);
});

test('wrong genesis blocks temporary identities and all funding/anchor activity', async () => {
  const fx = await fixture({ genesis: 'wrong-network' });
  await assert.rejects(fx.adapter.createTestIdentities(), /not Solana devnet/);
  assert.equal(fx.state.airDrops, 0); assert.equal(fx.state.sends, 0);
  assert.deepEqual(fx.state.calls.map(call => call.name), ['getGenesisHash']);
});
