#!/usr/bin/env node
// Treasury release check (P2 A-T3). The focused default build must bundle no shared Payables/Portfolio
// module, and every procedure its import graph can call must belong to a capability that
// web/contract.json declares. Capabilities come from Proto's contract package; nothing is copied here.
// Compatibility is not authorization: the gateway and agent still authorize every call.
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mayCall, ownerCapabilities } from '@multiagency/sdk';
import { SyntaxKind } from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const repo = fileURLToPath(new URL('../', import.meta.url)), web = join(repo, 'web');
/**
 * Procedures that send, save or sign: every owner procedure an account without any authority may not
 * call, by the SDK's own rule. They never go in the query library, so no retry or refetch can repeat one.
 */
const NO_AUTHORITY = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
const SENDS = new Set(Object.values(ownerCapabilities).flatMap(capability => capability.procedures).filter(procedure => !mayCall(NO_AUTHORITY, procedure)));
/** Query-library entry points whose arguments hold queryFn/mutationFn, and the oRPC utility options builders. */
const LIBRARY_CALLS = new Set(['useQuery', 'useQueries', 'useSuspenseQuery', 'useSuspenseQueries', 'useInfiniteQuery', 'useMutation', 'queryOptions', 'infiniteQueryOptions', 'mutationOptions']);
const OPTION_BUILDERS = new Set(['queryOptions', 'mutationOptions', 'streamedOptions', 'liveOptions', 'infiniteOptions']);
const LIBRARY_FUNCTIONS = new Set(['queryFn', 'mutationFn']);
const ACCOUNT_SCOPED = new Set(['queries', 'payablesQueries']);

/** `a.b.c(...)` → { root: "a", names: ["b", "c"] }, through calls, element access and type assertions. */
function chain(node) {
  const names = [];
  for (;;) {
    if (node.kind === SyntaxKind.PropertyAccessExpression) { names.unshift(node.name.text); node = node.expression; }
    else if ([SyntaxKind.CallExpression, SyntaxKind.ElementAccessExpression, SyntaxKind.NonNullExpression, SyntaxKind.ParenthesizedExpression, SyntaxKind.AsExpression, SyntaxKind.AwaitExpression].includes(node.kind)) node = node.expression;
    else return { root: node.kind === SyntaxKind.Identifier ? node.text : null, names };
  }
}
/** The send a call chain reaches, if any: `client.autopilot.stop` → "autopilot/stop". */
const sendOf = names => names.map((_, k) => names.slice(0, k + 1).join('/')).find(path => SENDS.has(path));
function visit(node, each) { each(node); node.forEachChild(child => visit(child, each)); }
/** Local names of the named imports in `file`: `import { queries as q }` maps "q" → "queries". */
function imported(file) {
  const names = new Map();
  for (const statement of file.statements) if (statement.kind === SyntaxKind.ImportDeclaration)
    for (const element of statement.importClause?.namedBindings?.elements ?? []) names.set(element.name.text, (element.propertyName ?? element.name).text);
  return names;
}
const propertyName = node => node.name?.kind === SyntaxKind.Identifier || node.name?.kind === SyntaxKind.StringLiteral ? node.name.text : null;
const failures = [];
const fail = message => failures.push(message);

// 1. The manifest names only known capabilities, as P2 manifest v1 defines it.
const manifest = JSON.parse(readFileSync(join(web, 'contract.json'), 'utf8'));
if (manifest.version !== 1 || manifest.product !== 'treasury') fail('contract.json must declare version 1 and product "treasury"');
if (manifest.entries?.['/'] !== 'index.html' || manifest.fallback !== 'index.html') fail('contract.json must declare entries {"/": "index.html"} and fallback "index.html"');
for (const [route, file] of Object.entries(manifest.entries ?? {})) if (!/^\/[a-z0-9./-]*$/.test(route) || typeof file !== 'string') fail(`Invalid entry ${route}`);
const required = manifest.required ?? [];
if (new Set(required).size !== required.length) fail('contract.json repeats a required capability');
for (const name of [...required, ...(manifest.optional ?? [])]) if (!Object.hasOwn(ownerCapabilities, name)) fail(`Unknown capability: ${name}`);
const procedures = [...new Set(required.filter(name => Object.hasOwn(ownerCapabilities, name)).flatMap(name => ownerCapabilities[name].procedures))].sort();

// 2. The actual default build's module graph: modules placed in emitted chunks, not merely parsed.
process.env.PUBLIC_TREASURY_ONLY = 'true';
const { createRsbuild, loadConfig } = await import('@rsbuild/core');
const { content } = await loadConfig({ cwd: web });
content.logLevel = 'error';
const out = mkdtempSync(join(tmpdir(), 'treasury-frontend-graph-'));
const bundled = new Set();
try {
  const rsbuild = await createRsbuild({ cwd: web, rsbuildConfig: { ...content, output: { ...content.output, distPath: { root: out }, cleanDistPath: false },
    tools: { ...content.tools, rspack: config => {
      config.plugins.push({ apply(compiler) { compiler.hooks.done.tap('treasury-frontend-graph', stats => {
        const compilation = stats.compilation;
        for (const chunk of compilation.chunks) for (const module of compilation.chunkGraph.getChunkModulesIterable(chunk))
          for (const entry of [module, ...(module.modules ?? [])]) if (entry.resource) bundled.add(entry.resource.split('?')[0]);
      }); } });
      return config;
    } } } });
  await rsbuild.build();
  // Every declared entry and the fallback must exist in the built release.
  for (const file of [...Object.values(manifest.entries ?? {}), manifest.fallback].filter(Boolean))
    if (!existsSync(join(out, file))) fail(`Declared release file missing from the build: ${file}`);
} finally { rmSync(out, { recursive: true, force: true }); }
const app = [...bundled].filter(path => path.startsWith(repo) && !path.includes('/node_modules/') && /\.[cm]?[jt]sx?$/.test(path));
if (!app.length) fail('The default build reported no application modules');
const shared = /\/web\/src\/(?:features\/payables\/|features\/demo\/|features\/portfolio\/overview\.tsx|legacy\/surface\.ts)/;
for (const path of app) if (shared.test(path)) fail(`Default build bundles a shared-workspace module: ${path.slice(repo.length)}`);

// 3. Type-check the default build's import graph with the client narrowed to the declared procedures.
// The client's procedure alias is replaced in memory only; nothing is written to disk.
const config = join(web, '.treasury-frontend-contract.tsconfig.json'), clientFile = join(web, 'src/shared/client.ts');
const alias = 'export type ClientProcedure = OwnerProcedure;';
const declared = `export type ClientProcedure = ${procedures.map(procedure => JSON.stringify(procedure)).join(' | ') || 'never'};`;
// Only this build's graph: its two entries (main.tsx, and proposals/main.tsx for the Treasury app's page) and what they
// import, with `@legacy` resolved as the build resolves it.
const tsconfig = JSON.stringify({ extends: './tsconfig.json', files: ['./src/main.tsx', './src/proposals/main.tsx', './src/env.d.ts'], include: [],
  compilerOptions: { paths: { '@/*': ['./src/*'], '@legacy': ['./src/legacy/absent.ts'] } } });
let narrowed = false;
const api = new API({ cwd: repo, fs: {
  fileExists: path => resolve(path) === config ? true : undefined,
  readFile: path => {
    path = resolve(path);
    if (path === config) return tsconfig;
    if (path !== clientFile) return undefined;
    const source = readFileSync(path, 'utf8');
    narrowed = source.includes(alias);
    return source.replace(alias, declared);
  },
} });
try {
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const project = snapshot.getProject(config);
    if (!project) throw new Error('The contract check project did not load');
    const program = project.program;
    if (!narrowed) fail(`web/src/shared/client.ts no longer declares "${alias}"; review this check`);
    for (const d of [...program.getConfigFileParsingDiagnostics(), ...program.getProgramDiagnostics(), ...program.getSyntacticDiagnostics(),
      ...program.getGlobalDiagnostics(), ...program.getSemanticDiagnostics()])
      fail(`Undeclared or invalid use: ${(d.fileName ?? config).replace(repo, '')}: TS${d.code}: ${d.text}`);
    const checked = new Set(program.getSourceFileNames().map(name => resolve(name)));
    for (const path of app) if (!checked.has(path)) fail(`Bundled module outside the checked graph: ${path.slice(repo.length)}`);
    // Sends stay on the app's explicit controls: the query library may cache, retry and refetch reads only.
    for (const path of checked) {
      if (!path.startsWith(join(web, 'src') + '/')) continue;
      const file = program.getSourceFile(path), name = path.slice(repo.length);
      if (!file) { fail(`No syntax tree for ${name}`); continue; }
      const imports = imported(file), original = local => imports.get(local) ?? local;
      // `queries` is a live binding rescoped per signed-in account: a module-level copy (any declaration
      // kind, any destructuring) would keep an earlier account's keys.
      for (const statement of file.statements) if (statement.kind === SyntaxKind.VariableStatement)
        for (const declaration of statement.declarationList.declarations)
          if (declaration.initializer && ACCOUNT_SCOPED.has(original(chain(declaration.initializer).root)))
            fail(`Module-level copy of the account-scoped queries in ${name}: ${declaration.getText(file)}`);
      // A send reached from inside a query-library function or call, or built into oRPC query options.
      const sendsWithin = (node, where) => visit(node, inner => {
        if (inner.kind !== SyntaxKind.CallExpression) return;
        const send = sendOf(chain(inner.expression).names);
        if (send) fail(`A send runs inside ${where} in ${name}: ${send}`);
      });
      visit(file, node => {
        if (node.kind === SyntaxKind.CallExpression) {
          const { names, root } = chain(node.expression), last = names.at(-1) ?? original(root);
          if (OPTION_BUILDERS.has(last) && names.length > 1) {
            const send = sendOf(names.slice(0, -1));
            if (send) fail(`A send is wrapped in query-library ${last} in ${name}: ${send}`);
          }
          if (LIBRARY_CALLS.has(last)) for (const argument of node.arguments) sendsWithin(argument, last);
        }
        if ((node.kind === SyntaxKind.PropertyAssignment || node.kind === SyntaxKind.MethodDeclaration) && LIBRARY_FUNCTIONS.has(propertyName(node)))
          sendsWithin(node.initializer ?? node.body, propertyName(node));
      });
    }
    // The app builds against the published contract, not the copied backend: not even types may come from src/.
    for (const path of checked) if (path.startsWith(join(repo, 'src') + '/')) fail(`The default build's graph uses the copied backend: ${path.slice(repo.length)}`);
  } finally { snapshot.dispose(); }
} finally { api.close(); }

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Treasury frontend contract holds: ${app.length} bundled modules, ${required.length} capabilities, ${procedures.length} procedures, ${SENDS.size} sends guarded.`);
