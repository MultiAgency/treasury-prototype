#!/usr/bin/env node
// Treasury creation on Proto's hosted setup: a Treasury frontend release, served by Proto's release server
// on a local Proto stack, creates a new treasury agent through its own screens (create → onboarding →
// setup progress) with Proto's `POST /gw/agents`, a simulated provider and the test owner wallet.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openProto } from '../proto-snapshot.mjs';

const here = import.meta.dirname, repo = resolve(here, '../..');
const { values: options } = parseArgs({ options: {
  proto: { type: 'string', default: process.env.PROTO_DIR ?? resolve(repo, '../proto') },
  release: { type: 'string', default: join(repo, '.test-artifacts/releases/treasury-a7') },
  previous: { type: 'string', default: join(repo, '.test-artifacts/releases/treasury-a6') },
  headed: { type: 'boolean', default: false },
} });
const source = openProto(options.proto), { pinned } = source;
const parent = join(repo, '.test-artifacts/demo-creation'); mkdirSync(parent, { recursive: true });
const artifacts = mkdtempSync(join(parent, 'run-')), snapshot = join(artifacts, 'proto');
const sha = text => createHash('sha256').update(text).digest('hex');
const receipt = { story: 'Treasury creation through its own screens on Proto hosted setup', simulated: 'provider, chain and owner wallet signatures are simulated; no real funds or credentials', checks: {} };
source.copy(snapshot);

// Test-only harness overlay, applied to this run's verified copy, never to Proto: Proto's owner-app host
// entry offers no hosted setup areas, so a Treasury release served there could not reach `POST /gw/agents`.
// `ownerApp.setupAreas` adds the host's `hostedAreas` and enables `selfService`, as a hosted Treasury host would.
const environmentFile = join(snapshot, 'test/e2e/environment.mjs');
const original = readFileSync(environmentFile, 'utf8');
const overlay = [
  ['frontend: { origin: release.origin, product: ownerApp.product } } } })', 'frontend: { origin: release.origin, product: ownerApp.product }, ...(ownerApp.setupAreas && { hostedAreas: ownerApp.setupAreas }) } } })'],
  ['...(secondAccount && { selfService: true })', '...((secondAccount || ownerApp?.setupAreas) && { selfService: true })'],
];
let patched = original;
for (const [from, to] of overlay) {
  if (patched.split(from).length !== 2) throw new Error(`Harness overlay anchor not found once in environment.mjs: ${from}`);
  patched = patched.replace(from, to);
}
writeFileSync(environmentFile, patched);
receipt.provenance = { node: process.version, ...source.provenance(snapshot),
  harnessOverlay: { file: 'test/e2e/environment.mjs', before: sha(original), after: sha(patched), overlay } };

console.log(`Treasury creation on Proto hosted setup · artifacts ${artifacts}`);
console.log('SIMULATED: provider, chain and owner wallet. No real funds, credentials or signatures.');
if (pinned) console.log(`Proto: pinned snapshot ${pinned.runDigest} (verified; test-only harness overlay ${sha(patched).slice(0, 12)}…)`);
const { offlineEnvironment } = await import(join(snapshot, 'scripts/test-environment.mjs'));
source.build(snapshot, artifacts, offlineEnvironment());
const { environment } = await import(environmentFile);
const { browserContext } = await import(join(snapshot, 'test/e2e/wallet.mjs'));
const { OWNER } = await import(join(snapshot, 'test/e2e/provider.mjs'));
const { chromium } = createRequire(join(snapshot, 'package.json'))('@playwright/test');

/** Methods that save, sign or send other than the agent's creation; none may be called. */
const SENDS = /\/rpc\/(rebalance|executePlan|externalPlan|sweep|pay|deposit|treasury\/fund|strategy\/save|autopilot\/(set|enable|tick|stop)|recover)$/;
const stack = await environment(join(artifacts, 'environment'), { ownerApp: { product: 'treasury', a: resolve(options.release), b: resolve(options.previous), setupAreas: ['treasury'] } });
const browser = await chromium.launch({ headless: !options.headed, slowMo: options.headed ? 250 : 0 });
let ok = false, page;
const check = (name, value) => { receipt.checks[name] = value; console.log(`   ${value ? 'ok  ' : 'FAIL'} ${name}`); return value; };
try {
  receipt.provenance.treasuryRelease = { path: resolve(options.release), digest: stack.release.ids.a };
  const owner = await browserContext(browser, stack, OWNER);
  owner.context.setDefaultTimeout(15_000);
  page = await owner.context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Refused or failed agent reads, kept for the receipt: a fresh hosted agent may answer before it is ready.
  const refusals = []; receipt.refusals = refusals;
  page.on('response', async response => {
    const path = new URL(response.url()).pathname;
    if (path === '/gw/me') receipt.identity = [...(receipt.identity ?? []), { at: new Date().toISOString(), page: new URL(page.url()).pathname, access: Object.keys((await response.json().catch(() => ({}))).viewer?.access ?? {}) }];
    if (response.status() >= 400 && /^\/(a\/[a-z0-9-]+\/rpc|gw)\//.test(path))
      refusals.push({ at: new Date().toISOString(), path, status: response.status(), body: (await response.text().catch(() => '')).slice(0, 300) });
  });
  const requests = () => owner.applicationRequests.map(({ method, url }) => `${method} ${new URL(url).pathname}`);

  console.log('\n── Owner signs in on the Treasury release');
  await page.goto(`${stack.dashboard}/`);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Create your Treasury', exact: true }).waitFor();
  const me = await page.evaluate(async () => (await fetch('/gw/me')).json());
  check('signed in as the owner, with hosted treasury setup offered', me.viewer?.account === OWNER && me.selfService === true && JSON.stringify(me.setupAreas) === '["treasury"]');

  console.log('── Owner continues: Proto reserves a hosted treasury agent');
  const reservation = page.waitForRequest(request => new URL(request.url()).pathname === '/gw/agents' && request.method() === 'POST');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const body = (await reservation).postDataJSON();
  check('POST /gw/agents names the owner, a wallet owner and the treasury area', JSON.stringify(body) === JSON.stringify({ owner: OWNER, kind: 'wallet', area: 'treasury' }));
  const create = page.getByRole('button', { name: 'Create agent', exact: true });
  // Proto keeps a hosted agent closed until its server first answers; a page opened earlier sees no access.
  const unavailable = page.getByRole('heading', { name: 'Access unavailable', exact: true });
  await create.or(unavailable).first().waitFor();
  if (check('the new workspace opens without a transient access refusal', !(await unavailable.isVisible()))) {} else {
    console.log('     The page shows "Access unavailable" while the new agent starts; using its "Check access again".');
    for (const deadline = Date.now() + 30_000; !(await create.isVisible());) {
      if (Date.now() > deadline) throw new Error('Access to the new agent was not granted within 30 s');
      if (await unavailable.isVisible()) await page.getByRole('button', { name: 'Check access again', exact: true }).click();
      await page.waitForTimeout(1_000);
    }
    receipt.accessRecovered = { after: 'Check access again', at: new Date().toISOString() };
  }
  const agent = new URL(page.url()).pathname.match(/^\/a\/([a-z0-9-]+)\//)?.[1];
  receipt.agent = agent;
  check('the new agent opens in its own workspace', /^own-[0-9a-f]{24}$/.test(agent ?? ''));
  check('registration signed and created nothing', owner.signatures.length === 1 && !stack.simulated.intents.some(i => i.type === 'agent_create'));

  console.log('── Owner creates the agent: one prepared request, signed in the test wallet');
  await create.click();
  const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog'));
  if (await dialog.getByRole('button', { name: 'Create agent', exact: true }).isVisible().catch(() => false)) await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
  const created = async () => stack.simulated.intents.find(i => i.type === 'agent_create' && i.created);
  for (const deadline = Date.now() + 20_000; !(await created());) { if (Date.now() > deadline) throw new Error('The provider did not create the agent'); await new Promise(r => setTimeout(r, 200)); }
  const intent = await created();
  const id = intent.created;
  receipt.provider = { agentId: id, correlationId: intent.correlation_id, policyActions: intent.createRequest.policy?.actions ?? null };
  // Setup progress: the agent is configured and its policy applied; the grant and strategy come next.
  const progress = async () => {
    await page.getByRole('heading', { name: 'Continue setup', exact: true }).waitFor();
    await page.getByText('An agent is configured.', { exact: false }).first().waitFor();
    await page.getByText('The policy is reported in force.', { exact: false }).first().waitFor();
    await page.getByText('No current grant was reported for this instance.', { exact: true }).waitFor();
  };
  await progress();
  const setup = await page.evaluate(async name => (await (await fetch(`/a/${name}/rpc/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).json, agent);
  receipt.setup = { agentId: setup?.agentId ?? null, executor: setup?.executor ?? null };
  check('setup progress reports the agent the provider created, with its policy in force and no grant yet', setup?.agentId === id);
  check('the owner signed exactly one owner action', owner.signatures.length === 2);
  check('the creation request is the treasury policy for this owner', intent.createRequest.owner?.account_id === OWNER);

  console.log('── Reload resumes setup progress; nothing is resent');
  const before = stack.simulated.intents.length;
  await page.reload();
  await progress();
  check('reload resumes at the next step without a new owner request', stack.simulated.intents.length === before && owner.signatures.length === 2);

  receipt.requests = requests();
  check('the copied backend route /gw/treasuries was never called', !receipt.requests.some(r => r.endsWith(' /gw/treasuries')));
  check('nothing was sent: no rebalance, execution, sweep, payment, funding, strategy save or schedule change', !receipt.requests.some(r => SENDS.test(r.split(' ')[1])));
  check('owner/prepare and owner/submit each ran once', receipt.requests.filter(r => r.endsWith('/rpc/owner/prepare')).length === 1 && receipt.requests.filter(r => r.endsWith('/rpc/owner/submit')).length === 1);
  check('no page errors, unexpected requests or simulator errors', errors.length === 0 && owner.unexpected.length === 0 && stack.simulated.errors.length === 0);
  receipt.pageErrors = errors; receipt.unexpected = owner.unexpected; receipt.simulatorErrors = stack.simulated.errors;
  ok = Object.values(receipt.checks).every(Boolean);
} catch (error) {
  console.log(`   Stopped: ${error.message}`);
  receipt.stopped = error.message;
  // Where the owner's page stopped, for diagnosis; it holds no credential.
  if (page) {
    receipt.stoppedAt = { url: page.url(), text: (await page.locator('body').innerText().catch(() => '')).slice(0, 2000),
      gateway: await page.evaluate(async () => (await fetch('/gw/me')).json()).catch(error => String(error)) };
    await page.screenshot({ path: join(artifacts, 'stopped.png'), fullPage: true }).catch(() => {});
  }
} finally {
  await browser.close(); await stack.close();
  if (pinned) {
    receipt.provenance.protoSnapshot.unchangedAfterRun = source.unchanged();
    if (!receipt.provenance.protoSnapshot.unchangedAfterRun) ok = false;
  }
  receipt.result = ok ? 'as expected' : 'unexpected';
  writeFileSync(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(`\nReceipt: ${join(artifacts, 'receipt.json')} (${receipt.result})`);
  process.exitCode = ok ? 0 : 1;
}
