import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || process.argv.length !== 3) throw new Error('Usage: node scripts/package-treasury-frontend.mjs NEW_OUTPUT_DIRECTORY');
if (existsSync(output)) throw new Error('Output already exists; choose a new directory to preserve the reviewed artifact.');
const inside = (base, target) => { const name = relative(base, target); return name !== '' && !name.startsWith('..') && !isAbsolute(name); };
if (!inside(join(root, '.test-artifacts'), output) && !inside('/tmp', output))
  throw new Error('Use a new directory under .test-artifacts/ or /tmp/.');

function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (['node_modules', 'dist'].includes(entry.name)) return [];
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not packaged.');
    const name = prefix + entry.name;
    return entry.isDirectory() ? files(join(directory, entry.name), name + '/') : [name];
  });
}
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceDigest = () => {
  const names = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', ...['src','web','evidence','skills'].flatMap(dir => files(join(root, dir)).map(name => dir + '/' + name))].sort();
  return hash(names.map(name => name + '\0' + hash(readFileSync(join(root,name)))).join('\n'));
};

// The SDK is linked from Proto's checkout, so the manifest records what it was built against: the digest of
// the files the package publishes (its `files` list, as `pnpm pack` would include them, without the
// pack-time provenance.json), and whether Proto's packed tarball of that version has the same contents.
const sdkDir = realpathSync(join(root, 'node_modules/@multiagency/sdk'));
const tarballs = join(sdkDir, '../../.test-artifacts/contract');
const walk = (directory, prefix = '') => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name), prefix + entry.name + '/') : entry.isFile() ? [prefix + entry.name] : []);
// Packing rewrites package.json, so it is compared as parsed JSON.
const fileHashes = (directory, names) => new Map(names.filter(name => name !== 'provenance.json').sort().map(name => [name,
  hash(name === 'package.json' ? JSON.stringify(JSON.parse(readFileSync(join(directory, name), 'utf8'))) : readFileSync(join(directory, name)))]));
const contentsDigest = hashes => hash([...hashes].map(([name, value]) => name + '\0' + value).join('\n'));
function sdkProvenance() {
  const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
  const include = pkg.files.filter(entry => !entry.startsWith('!')), exclude = pkg.files.filter(entry => entry.startsWith('!')).map(entry => entry.slice(1));
  const under = (name, entry) => name === entry || name.startsWith(entry + '/');
  const published = walk(sdkDir).filter(name => !under(name, 'node_modules'))
    .filter(name => name === 'package.json' || (include.some(entry => under(name, entry)) && !exclude.some(entry => under(name, entry))));
  const linked = fileHashes(sdkDir, published), digest = contentsDigest(linked);
  // Proto's tarball of the same version: recorded as matching, or with the files that differ.
  const file = `multiagency-sdk-${pkg.version}.tgz`, tarball = { file, sha256: null, matches: false, differs: [] };
  if (!existsSync(join(tarballs, file))) return { name: pkg.name, version: pkg.version, linked: relative(root, sdkDir), contentsDigest: digest, tarball: null };
  const unpacked = mkdtempSync(join(staging, '.sdk-'));
  try {
    if (spawnSync('tar', ['-xzf', join(tarballs, file), '-C', unpacked]).status !== 0) throw new Error(`Could not unpack ${file}`);
    const packed = fileHashes(join(unpacked, 'package'), walk(join(unpacked, 'package')));
    tarball.sha256 = hash(readFileSync(join(tarballs, file)));
    tarball.differs = [...new Set([...linked.keys(), ...packed.keys()])].sort().filter(name => linked.get(name) !== packed.get(name));
    tarball.matches = tarball.differs.length === 0;
  } finally { rmSync(unpacked, { recursive: true, force: true }); }
  return { name: pkg.name, version: pkg.version, linked: relative(root, sdkDir), contentsDigest: digest, tarball };
}
mkdirSync(dirname(output), { recursive: true });
const staging = mkdtempSync(join(dirname(output), '.treasury-frontend-'));
try {
  const before = sourceDigest(), sdk = sdkProvenance();
  const env = Object.fromEntries(['PATH','HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ','TERM','NO_COLOR','FORCE_COLOR']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const dist = join(staging,'frontend');
  // Independent output avoids races with other sessions rebuilding web/dist. Never load .env files.
  const build = spawnSync('pnpm', ['build:web','--dist-path',dist,'--no-env'], {
    cwd: root, env: { ...env, NODE_ENV:'production', PUBLIC_TREASURY_ONLY:'true' }, stdio:'inherit',
  });
  if (build.error || build.status !== 0) throw new Error('Focused Treasury build failed.');
  if (sourceDigest() !== before || sdkProvenance().contentsDigest !== sdk.contentsDigest) throw new Error('Source or SDK changed during the build; retry.');
  const assets = files(dist);
  if (!assets.includes('index.html')) throw new Error('Build has no index.html.');
  const manifest = { version:1, product:'treasury', presentation:'focused', sourceDigest:before, sdk,
    files:assets.map(path => { const value=readFileSync(join(dist,path)); return {path,bytes:value.length,sha256:hash(value)}; }) };
  writeFileSync(join(staging,'manifest.json'), JSON.stringify(manifest,null,2)+'\n', {flag:'wx'});
  if (existsSync(output)) throw new Error('Output appeared during build; choose a new directory.');
  renameSync(staging,output);
  console.log(`Focused Treasury assets: ${join(output,'frontend')}\nManifest: ${join(output,'manifest.json')}`);
} finally {
  rmSync(staging,{recursive:true,force:true});
}
