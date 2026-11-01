import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = value => value.split(sep).join('/');
const excluded = Object.freeze([
  'node_modules/', 'receipts-private/', 'artifacts/', 'third_party/', '.git/',
  '.env*', '*.key', '*-keypair.json', '*.log', 'test-results/',
  'tests/devnet-integration.mjs', 'all other files not explicitly allowlisted'
]);
const fixedFiles = Object.freeze([
  '.gitattributes', '.gitignore', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'package-lock.json',
  'scripts/build.mjs', 'scripts/serve.mjs', 'scripts/export-source.mjs',
  'src/solana-vendor.mjs',
  'dist/app.mjs', 'dist/index.html', 'dist/about.html', 'dist/styles.css',
  'dist/lib/core.mjs', 'dist/lib/receipt-ui.mjs', 'dist/lib/solana.mjs',
  'dist/lib/solana-vendor.mjs', 'dist/licenses/README.md', 'dist/licenses/index.json',
  'tests/core.test.mjs', 'tests/solana.test.mjs', 'tests/ui-flow.test.mjs',
  'tests/export-source.test.mjs'
]);
const licenseNames = Object.freeze([
  'addresses', 'assertions', 'codecs-core', 'codecs-data-structures',
  'codecs-numbers', 'codecs-strings', 'errors', 'fast-stable-stringify',
  'fixed-points', 'functional', 'instruction-plans', 'instructions', 'keys',
  'offchain-messages', 'promises', 'rpc-api', 'rpc-spec-types', 'rpc-spec',
  'rpc-transformers', 'rpc-transport-http', 'rpc-types', 'rpc', 'signers',
  'subscribable', 'transaction-messages', 'transactions'
]);
const licenseFiles = licenseNames.map(name => `dist/licenses/solana--${name}@8.6.0/LICENSE`);
const publicConstants = new Set([
  '11111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'ComputeBudget111111111111111111111111111111',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'SysvarRecentB1ockHashes11111111111111111111',
  // Public RPC enum strings can coincidentally match the base58 alphabet.
  'MaxLoadedAccountsDataSizeExceeded', 'InvalidLoadedAccountsDataSizeLimit'
]);

function fail(code) { const error = new Error(code); error.code = code; throw error; }
export function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') ||
      isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_RELATIVE_PATH');
  return name;
}
function within(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
async function requireDirectory(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('UNSAFE_DIRECTORY');
}
export async function readSafe(root, name) {
  safeRelative(name);
  await requireDirectory(root);
  const pieces = name.split('/');
  let current = root;
  for (const part of pieces.slice(0, -1)) {
    current = resolve(current, part);
    await requireDirectory(current);
  }
  const path = resolve(root, name);
  if (!within(root, path)) fail('UNSAFE_SOURCE_PATH');
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 4 * 1024 * 1024) fail('UNSAFE_SOURCE_FILE');
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('SOURCE_CHANGED_DURING_READ');
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return bytes;
}

// Findings contain only locations and categories. Never retain matched values.
export function privacyScan(bytes, name, privateMarkers = []) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const findings = [];
  const allowed = { syntheticEmail: 0, publicProtocolOrFixture: 0 };
  const add = (category, index) => findings.push({ file: name, category, line: text.slice(0, index).split('\n').length });
  const patterns = [
    ['private-key-pem', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g],
    ['credential-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g],
    ['bearer-or-jwt', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
    ['credential-url', /https?:\/\/[^\s/"'<>]{1,128}:[^\s/"'<>]{1,128}@/g],
    ['absolute-home-path', /(?:\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:home|Users)\/[^\s/"'<>]+\/)/g],
    ['private-key-byte-array', /(?:secretKey|privateKey)\s*["']?\s*[:=]\s*\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g]
  ];
  for (const [category, pattern] of patterns) for (const match of text.matchAll(pattern)) add(category, match.index);
  for (const match of text.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}\b/g)) {
    if (match[0].toLowerCase().endsWith('.invalid')) allowed.syntheticEmail++;
    else add('unreviewed-email', match.index);
  }
  for (const match of text.matchAll(/(['"])([1-9A-HJ-NP-Za-km-z]{32,44})\1/g)) {
    if (publicConstants.has(match[2])) allowed.publicProtocolOrFixture++;
    else add('unreviewed-address-shaped-literal', match.index);
  }
  for (const marker of privateMarkers) {
    if (typeof marker !== 'string' || marker.length < 4) fail('INVALID_PRIVATE_MARKER');
    const index = text.toLowerCase().indexOf(marker.toLowerCase());
    if (index !== -1) add('private-deny-marker', index);
  }
  return { findings, allowed };
}

async function createParents(root, name) {
  await requireDirectory(root);
  let current = root;
  for (const part of name.split('/').slice(0, -1)) {
    current = resolve(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await requireDirectory(current);
  }
}
async function listedFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('EXPORT_CONTAINS_SYMLINK');
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listedFiles(root, path));
    else if (entry.isFile()) files.push(posix(relative(root, path)));
    else fail('EXPORT_CONTAINS_SPECIAL_FILE');
  }
  return files.sort();
}

export async function exportSource({ sourceRoot = projectRoot, outputRoot = resolve(sourceRoot, '../versionpass-source-export'), privateMarkers = [] } = {}) {
  sourceRoot = resolve(sourceRoot);
  outputRoot = resolve(outputRoot);
  if (dirname(outputRoot) !== dirname(sourceRoot) || within(sourceRoot, outputRoot) || within(outputRoot, sourceRoot)) fail('OUTPUT_MUST_BE_NEW_SIBLING');
  await requireDirectory(sourceRoot);
  try { await lstat(outputRoot); fail('OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const receiptRoot = resolve(sourceRoot, 'receipts-private');
  try { await mkdir(receiptRoot); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await requireDirectory(receiptRoot);
  const receiptPath = resolve(receiptRoot, `source-export-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  const receipt = { schema: 1, status: 'PREFLIGHT', recordedAtUtc: new Date().toISOString(),
    sourceRoot, outputRoot, files: [], excluded, outputCreated: false,
    privacy: { findings: [], allowed: { syntheticEmail: 0, publicProtocolOrFixture: 0 }, privateMarkerCount: privateMarkers.length },
    actions: { networkRequests: 0, packageInstalls: 0, gitOperations: 0, sourceFeatureEdits: 0, deletionsOrOverwrites: 0 } };
  try {
    const manifest = JSON.parse((await readSafe(sourceRoot, 'dist/licenses/index.json')).toString('utf8'));
    if (!manifest.complete || manifest.packages?.length !== 26 || manifest.missingFullLicensePackages?.length || manifest.licenseConflicts?.length) fail('LICENSE_COVERAGE_INCOMPLETE');
    const expectedLegal = [...licenseFiles].sort();
    const indexedLegal = manifest.packages.flatMap(pkg => {
      if (!pkg.hasFullLicenseFile || pkg.declaredLicense !== 'MIT' || pkg.materialLicense !== 'MIT') fail('UNREVIEWED_DEPENDENCY_LICENSE');
      return pkg.files.map(file => ({ ...file, path: 'dist/licenses/' + safeRelative(file.path) }));
    });
    if (JSON.stringify(indexedLegal.map(file => file.path).sort()) !== JSON.stringify(expectedLegal)) fail('LICENSE_ALLOWLIST_CHANGED');
    const files = [...fixedFiles, ...licenseFiles];
    const bundles = manifest.bundles ?? [];
    if (bundles.length < 1 || bundles.some(file => !['lib/solana-vendor.mjs', 'lib/solana-vendor.mjs.LEGAL.txt'].includes(file.path)) || !bundles.some(file => file.path === 'lib/solana-vendor.mjs')) fail('UNEXPECTED_BUNDLE_MANIFEST');
    if (bundles.some(file => file.path === 'lib/solana-vendor.mjs.LEGAL.txt')) files.push('dist/lib/solana-vendor.mjs.LEGAL.txt');
    files.sort();
    const snapshots = new Map();
    for (const name of files) {
      const bytes = await readSafe(sourceRoot, name);
      const scan = privacyScan(bytes, name, privateMarkers);
      receipt.privacy.findings.push(...scan.findings);
      for (const key of Object.keys(scan.allowed)) receipt.privacy.allowed[key] += scan.allowed[key];
      snapshots.set(name, bytes);
      receipt.files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
    }
    if (receipt.privacy.findings.length) fail('PRIVACY_REVIEW_REQUIRED');
    for (const file of [...indexedLegal, ...bundles.map(file => ({ ...file, path: 'dist/' + file.path }))]) {
      const bytes = snapshots.get(file.path);
      if (!bytes || bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail('LICENSE_OR_BUNDLE_HASH_MISMATCH');
    }
    const stableSource = async () => {
      for (const file of receipt.files) if (digest(await readSafe(sourceRoot, file.path)) !== file.sha256) fail('SOURCE_CHANGED_SINCE_PREFLIGHT');
    };
    await stableSource();
    await mkdir(outputRoot); // Exclusive creation; never remove or reuse an existing export.
    receipt.outputCreated = true;
    for (const [name, bytes] of snapshots) {
      await createParents(outputRoot, name);
      await writeFile(resolve(outputRoot, name), bytes, { flag: 'wx' });
    }
    if (JSON.stringify(await listedFiles(outputRoot)) !== JSON.stringify(files)) fail('EXPORT_FILE_SET_MISMATCH');
    for (const file of receipt.files) if (digest(await readSafe(outputRoot, file.path)) !== file.sha256) fail('EXPORT_HASH_MISMATCH');
    await stableSource();
    receipt.sourceAndCopyStable = true;
    receipt.licensePackages = 26;
    receipt.fileCount = receipt.files.length;
    receipt.totalBytes = receipt.files.reduce((sum, file) => sum + file.bytes, 0);
    receipt.manifestSha256 = digest(JSON.stringify(receipt.files));
    receipt.status = 'COMPLETE_PRIVATE_SOURCE_EXPORT';
    receipt.completedAtUtc = new Date().toISOString();
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return { status: receipt.status, fileCount: receipt.fileCount, outputRoot, receiptPath, manifestSha256: receipt.manifestSha256 };
  } catch (error) {
    receipt.status = 'FAILED_NOT_APPROVED_FOR_PUBLICATION';
    receipt.failureCode = error.code ?? 'EXPORT_FAILED';
    receipt.failedAtUtc = new Date().toISOString();
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    error.receiptPath = receiptPath;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('NO_CLI_ARGUMENTS_SUPPORTED');
    const privateMarkers = JSON.parse(process.env.VERSIONPASS_EXPORT_PRIVATE_MARKERS ?? '[]');
    if (!Array.isArray(privateMarkers)) fail('INVALID_PRIVATE_MARKERS');
    console.log(JSON.stringify(await exportSource({ privateMarkers })));
  } catch (error) {
    console.error(JSON.stringify({ status: 'EXPORT_REFUSED', code: error.code ?? 'EXPORT_FAILED', receiptPath: error.receiptPath ?? null }));
    process.exitCode = 1;
  }
}
