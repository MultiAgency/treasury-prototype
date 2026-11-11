import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  const names = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', ...['src','web','evidence','skills','vendor'].flatMap(dir => files(join(root, dir)).map(name => dir + '/' + name))].sort();
  return hash(names.map(name => name + '\0' + hash(readFileSync(join(root,name)))).join('\n'));
};
mkdirSync(dirname(output), { recursive: true });
const staging = mkdtempSync(join(dirname(output), '.treasury-frontend-'));
try {
  const before = sourceDigest();
  const env = Object.fromEntries(['PATH','HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ','TERM','NO_COLOR','FORCE_COLOR']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const dist = join(staging,'frontend');
  // Independent output avoids races with other sessions rebuilding web/dist. Never load .env files.
  const build = spawnSync('pnpm', ['build:web','--dist-path',dist,'--no-env'], {
    cwd: root, env: { ...env, NODE_ENV:'production', PUBLIC_TREASURY_ONLY:'true' }, stdio:'inherit',
  });
  if (build.error || build.status !== 0) throw new Error('Focused Treasury build failed.');
  if (sourceDigest() !== before) throw new Error('Source changed during the build; freeze the candidate and retry.');
  const assets = files(dist);
  if (!assets.includes('index.html')) throw new Error('Build has no index.html.');
  const manifest = { version:1, product:'treasury', presentation:'focused', sourceDigest:before,
    files:assets.map(path => { const value=readFileSync(join(dist,path)); return {path,bytes:value.length,sha256:hash(value)}; }) };
  writeFileSync(join(staging,'manifest.json'), JSON.stringify(manifest,null,2)+'\n', {flag:'wx'});
  if (existsSync(output)) throw new Error('Output appeared during build; choose a new directory.');
  renameSync(staging,output);
  console.log(`Focused Treasury assets: ${join(output,'frontend')}\nManifest: ${join(output,'manifest.json')}`);
} finally {
  rmSync(staging,{recursive:true,force:true});
}
