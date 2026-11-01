import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { exportSource, privacyScan, readSafe, safeRelative } from '../scripts/export-source.mjs';

const bytes = text => Buffer.from(text);
async function cleanFixture(temporary) {
  const target = resolve(temporary);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('versionpass-export-')) {
    throw new Error('Refusing cleanup outside the newly created temporary fixture.');
  }
  await rm(target, { recursive: true, force: true });
}

test('source export rejects traversal and alternate path separators', () => {
  for (const path of ['../secret', 'dist/../secret', '/absolute', 'dist//file', 'dist\\file', 'drive:file']) {
    assert.throws(() => safeRelative(path), { code: 'UNSAFE_RELATIVE_PATH' });
  }
  assert.equal(safeRelative('dist/lib/core.mjs'), 'dist/lib/core.mjs');
});

test('privacy findings retain categories and locations, never matching values', () => {
  const token = 'gh' + 'p_' + 'z'.repeat(36);
  const contact = 'synthetic-person' + '@' + 'example.com';
  const secretArray = 'secret' + 'Key = [' + Array(64).fill(3).join(',') + ']';
  const input = [token, contact, secretArray, '2'.repeat(44)].join('\n');
  const result = privacyScan(bytes(input), 'synthetic.mjs', ['synthetic-person']);
  assert.deepEqual(new Set(result.findings.map(item => item.category)), new Set([
    'credential-token', 'unreviewed-email', 'private-key-byte-array', 'private-deny-marker'
  ]));
  const serialized = JSON.stringify(result);
  for (const value of [token, contact, secretArray]) assert.equal(serialized.includes(value), false);
  assert.deepEqual(result.findings.find(item => item.category === 'credential-token'),
    { file: 'synthetic.mjs', category: 'credential-token', line: 1 });
});

test('public protocol constants and explicitly synthetic email remain exportable', () => {
  const result = privacyScan(bytes("const system = '11111111111111111111111111111111';\nconst email = 'synthetic@example.invalid';\nconst secretKey = [1, 2, 3];"), 'fixture.mjs');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.allowed, { syntheticEmail: 1, publicProtocolOrFixture: 1 });
  assert.equal(privacyScan(bytes("const address = '" + '2'.repeat(44) + "';"), 'fixture.mjs').findings[0].category,
    'unreviewed-address-shaped-literal');
  assert.deepEqual(privacyScan(bytes('dist/licenses/solana--addresses@8.6.0/LICENSE'), 'index.json').findings, []);
});

test('an existing export is rejected before touching its contents or creating a receipt', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'versionpass-export-test-'));
  try {
    const sourceRoot = join(temporary, 'source');
    const outputRoot = join(temporary, 'source-export');
    await mkdir(sourceRoot); await mkdir(outputRoot);
    await writeFile(join(outputRoot, 'keep.txt'), 'preserve existing bytes');
    await assert.rejects(exportSource({ sourceRoot, outputRoot }), { code: 'OUTPUT_EXISTS' });
    assert.equal(await readFile(join(outputRoot, 'keep.txt'), 'utf8'), 'preserve existing bytes');
    await assert.rejects(readFile(join(sourceRoot, 'receipts-private')), { code: 'ENOENT' });
    await assert.rejects(exportSource({ sourceRoot, outputRoot: join(sourceRoot, 'nested-export') }),
      { code: 'OUTPUT_MUST_BE_NEW_SIBLING' });
  } finally { await cleanFixture(temporary); }
});

test('a source-directory symlink cannot bring an external file into the export', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'versionpass-export-link-test-'));
  try {
    const source = join(temporary, 'source'), external = join(temporary, 'external');
    await mkdir(source); await mkdir(external);
    await writeFile(join(external, 'secret.txt'), 'synthetic private material');
    await symlink(external, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readSafe(source, 'linked/secret.txt'), { code: 'UNSAFE_DIRECTORY' });
    assert.equal(await readFile(join(external, 'secret.txt'), 'utf8'), 'synthetic private material');
  } finally { await cleanFixture(temporary); }
});
