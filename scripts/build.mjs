import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, rm, stat, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, basename, isAbsolute, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const moduleRoot = resolve(projectRoot, 'node_modules');
const licenseRoot = resolve(projectRoot, 'dist/licenses');
const posix = value => value.split(sep).join('/');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isWithin = (root, target) => {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};
async function existsFile(path) {
  try { return (await stat(path)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function packageFor(input) {
  let directory = dirname(resolve(projectRoot, input));
  if (!isWithin(moduleRoot, directory)) return null;
  while (isWithin(moduleRoot, directory) && directory !== moduleRoot) {
    if (await existsFile(join(directory, 'package.json'))) {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      // ESM distribution subfolders can contain only {type:module}; continue
      // to the owning published package instead of treating that as a package.
      if (typeof metadata.name === 'string' && typeof metadata.version === 'string') return directory;
    }
    directory = dirname(directory);
  }
  throw new Error('A bundled dependency has no identifiable package metadata.');
}
async function legalFiles(root, directory = root) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const result = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...await legalFiles(root, path));
    else if (entry.isFile() && /^(?:licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i.test(entry.name)) result.push(path);
  }
  return result;
}

// Build in memory first: missing license material must fail before this build
// replaces generated bundle artifacts. No registry/network calls are made here.
const result = await build({
  absWorkingDir: projectRoot,
  entryPoints: ['src/solana-vendor.mjs'],
  outfile: 'dist/lib/solana-vendor.mjs',
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
  minify: true, legalComments: 'linked', metafile: true, write: false,
  define: { 'process.env.NODE_ENV': '"production"' }
});

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs).sort()) {
  const directory = await packageFor(input);
  if (!directory) continue;
  if (!packages.has(directory)) packages.set(directory, []);
  packages.get(directory).push(posix(relative(directory, resolve(projectRoot, input))));
}
const copied = [];
const index = [];
const folders = new Set();
const missing = [];
const conflicts = [];
const upstreamPath = resolve(projectRoot, 'third_party/upstream-licenses/sources.json');
const upstreamSources = await existsFile(upstreamPath) ? JSON.parse(await readFile(upstreamPath, 'utf8')).packages : [];
const lock = JSON.parse(await readFile(resolve(projectRoot, 'package-lock.json'), 'utf8'));
const contribution = new Map();
for (const output of Object.values(result.metafile.outputs)) {
  for (const [input, detail] of Object.entries(output.inputs)) contribution.set(input, (contribution.get(input) ?? 0) + detail.bytesInOutput);
}
for (const directory of [...packages.keys()].sort()) {
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') throw new Error('A bundled dependency has incomplete package metadata.');
  const sourcePackage = posix(relative(projectRoot, directory));
  let folder = metadata.name.replace(/^@/, '').replaceAll('/', '--') + '@' + metadata.version;
  if (!/^[A-Za-z0-9@._+-]+$/.test(folder)) throw new Error('A package identity cannot be represented safely in the license output.');
  if (folders.has(folder)) folder += '-' + sha256(sourcePackage).slice(0, 12);
  folders.add(folder);
  let sources = (await legalFiles(directory)).map(source => ({ source, sourcePath: posix(relative(directory, source)), provenance: 'installed-package' }));
  const upstream = upstreamSources.find(entry => entry.name === metadata.name && entry.version === metadata.version);
  if (!sources.some(file => /^(?:licen[cs]e|copying)(?:[._-].*)?$/i.test(basename(file.source))) && upstream) {
    if (upstream.declaredLicense !== metadata.license || upstream.npm.distIntegrity !== lock.packages[sourcePackage]?.integrity || upstream.upstream.versionFile.name !== metadata.name || upstream.upstream.versionFile.version !== metadata.version) throw new Error('Vendored upstream identity does not match the installed package.');
    sources = upstream.files.map(file => {
      const source = resolve(projectRoot, upstream.sourceRoot, file.path);
      if (!isWithin(resolve(projectRoot, 'third_party/upstream-licenses'), source)) throw new Error('Unsafe vendored license source.');
      return { source, sourcePath: file.path, provenance: 'official-upstream-commit', expectedSha256: file.sha256, url: file.url, commit: upstream.upstream.commit };
    });
    if (upstream.sourceLicense !== metadata.license) conflicts.push({ name: metadata.name, version: metadata.version, declaredLicense: metadata.license, upstreamLicense: upstream.sourceLicense, commit: upstream.upstream.commit, reason: 'Exact-version client declares a different license from the only upstream repository LICENSE; not resolved by substitution.' });
  }
  const hasFullLicenseFile = sources.some(file => /^(?:licen[cs]e|copying)(?:[._-].*)?$/i.test(basename(file.source)));
  const bundledBytes = packages.get(directory).reduce((total, input) => total + (contribution.get(posix(relative(projectRoot, join(directory, input)))) ?? 0), 0);
  if (!hasFullLicenseFile) missing.push({ name: metadata.name, version: metadata.version, declaredLicense: metadata.license ?? null, sourcePackage, bundledBytes });
  const files = [];
  let licenseText = '';
  for (const file of sources) {
    const bytes = await readFile(file.source);
    if (!bytes.length) throw new Error('Empty legal material for ' + metadata.name);
    if (file.expectedSha256 && sha256(bytes) !== file.expectedSha256) throw new Error('Vendored upstream legal bytes do not match their source receipt.');
    const output = folder + '/' + file.sourcePath;
    copied.push({ output, bytes });
    files.push({ source: posix(relative(projectRoot, file.source)), path: output, bytes: bytes.length, sha256: sha256(bytes), provenance: file.provenance,
      ...(file.url ? { url: file.url, commit: file.commit } : {}) });
    licenseText += bytes.toString('utf8');
  }
  if (hasFullLicenseFile && !conflicts.some(conflict => conflict.name === metadata.name && conflict.version === metadata.version) && metadata.license === 'MIT' && (!licenseText.includes('Permission is hereby granted') || !licenseText.includes('THE SOFTWARE IS PROVIDED'))) throw new Error('Incomplete MIT notice for ' + metadata.name);
  const repository = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url ?? null;
  index.push({ name: metadata.name, version: metadata.version, declaredLicense: metadata.license ?? null,
    sourcePackage, repository, npm: 'https://www.npmjs.com/package/' + metadata.name + '/v/' + metadata.version, hasFullLicenseFile, bundledBytes,
    materialLicense: sources.some(file => file.provenance === 'official-upstream-commit') ? upstream.sourceLicense : metadata.license,
    inputFiles: packages.get(directory).sort(), files });
}
index.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
if (!index.length) throw new Error('The vendor bundle has no recorded dependency licenses.');
const bundles = result.outputFiles.map(output => ({ path: posix(relative(resolve(projectRoot, 'dist'), output.path)), bytes: output.contents.length, sha256: sha256(output.contents) }));
const manifest = { schema: 1, generator: 'scripts/build.mjs', complete: missing.length === 0 && conflicts.length === 0, missingFullLicensePackages: missing, licenseConflicts: conflicts, dependencySelection: 'All package inputs reachable in the esbuild browser graph, including any later removed by tree shaking.',
  licenseMaterial: 'Full legal files copied verbatim from installed packages or the pinned official upstream sources recorded per file; no absolute local paths.',
  bundles, packages: index };
const markdown = [
  '# Bundled third-party licenses', '',
  'Generated by scripts/build.mjs from the installed browser dependency graph. Keep this directory with the distributed vendor bundle. Full license and notice files are copied byte for byte; index.json records their sources and SHA-256 hashes.', '',
  ...(missing.length ? ['RELEASE BLOCKED: ' + missing.length + ' installed dependency packages omit full license files. This index is incomplete; no publication-ready package has been established.', ''] : []),
  ...(conflicts.length ? ['RELEASE BLOCKED: ' + conflicts.length + ' exact-version package declarations conflict with the preserved official upstream license. Full texts are retained, but the mismatch is unresolved.', ''] : []),
  '| Package | Declared license | Preserved material license | Full license / notices |',
  '| --- | --- | --- | --- |',
  ...index.map(pkg => '| ' + pkg.name + '@' + pkg.version + ' | ' + (pkg.declaredLicense ?? 'See files') + ' | ' + (pkg.materialLicense ?? 'See files') + ' | ' + (pkg.files.map(file => '[' + basename(file.path) + '](./' + file.path + ')').join(', ') || 'MISSING: release blocked') + ' |'),
  ''
].join('\n');

// Only this build-owned directory may be replaced. Refuse a symlink; no shared
// hosting tree, UI file or source directory is traversed or removed.
if (dirname(licenseRoot) !== resolve(projectRoot, 'dist') || basename(licenseRoot) !== 'licenses' || !isWithin(projectRoot, licenseRoot)) throw new Error('Unsafe generated license directory.');
try { if ((await lstat(licenseRoot)).isSymbolicLink()) throw new Error('Generated license directory must not be a symlink.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(licenseRoot, { recursive: true, force: true });
await mkdir(licenseRoot, { recursive: true });
for (const file of copied) {
  const target = resolve(licenseRoot, file.output);
  if (!isWithin(licenseRoot, target)) throw new Error('Unsafe generated legal file path.');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.bytes);
}
await writeFile(join(licenseRoot, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(licenseRoot, 'README.md'), markdown);
if (missing.length || conflicts.length) {
  console.error(JSON.stringify({ status: 'LICENSE_MATERIAL_INCOMPLETE_OR_CONFLICTING', packages: index.length, fullLegalFilesCopied: copied.length, missing, conflicts }));
  throw new Error('Full third-party license coverage is incomplete or conflicting. The existing bundle was not replaced; publication is blocked.');
}
for (const output of result.outputFiles) {
  if (!isWithin(resolve(projectRoot, 'dist/lib'), output.path)) throw new Error('Unexpected bundle output path.');
  await mkdir(dirname(output.path), { recursive: true });
  await writeFile(output.path, output.contents);
}
// A smaller dependency graph may no longer emit esbuild's linked comment
// sidecar. Remove only that fixed generated file, after complete legal coverage
// passed, so an older build's unrelated notices do not survive in the package.
const legalSidecar = resolve(projectRoot, 'dist/lib/solana-vendor.mjs.LEGAL.txt');
if (!isWithin(resolve(projectRoot, 'dist/lib'), legalSidecar)) throw new Error('Unsafe generated legal sidecar path.');
if (!result.outputFiles.some(output => output.path === legalSidecar)) await rm(legalSidecar, { force: true });
console.log('VERSIONPASS static bundle ready; ' + index.length + ' dependency packages, ' + copied.length + ' full license/notice files preserved.');
