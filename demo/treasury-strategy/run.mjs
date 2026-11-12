#!/usr/bin/env node
// Treasury strategy demo: the actual Treasury skill helper against an isolated local Proto with a
// simulated provider, chain and owner wallet. Proto supplies authority, records and execution; this
// recipe only supplies scenario inputs, the owner's simulated decisions and a receipt.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { digest, openProto } from '../proto-snapshot.mjs';

const here = import.meta.dirname, repo = resolve(here, '../..');
const { values: options } = parseArgs({ options: {
  scenario: { type: 'string', default: join(here, 'scenario.json') },
  proto: { type: 'string', default: process.env.PROTO_DIR ?? resolve(repo, '../proto') },
  fault: { type: 'string' },
  'lost-at': { type: 'string', default: '1' },
  yes: { type: 'boolean', default: false },
  pause: { type: 'boolean', default: false },
  headed: { type: 'boolean', default: false },
  helper: { type: 'string' },
} });
if (options.fault && !['lost-response', 'unbound-grant'].includes(options.fault)) throw new Error('--fault accepts lost-response or unbound-grant');
const lost = options.fault === 'lost-response', unbound = options.fault === 'unbound-grant';
const lostAt = Number(options['lost-at']);
const scenario = JSON.parse(readFileSync(resolve(options.scenario), 'utf8'));
if (!Array.isArray(scenario.swaps) || !scenario.swaps.length || !scenario.strategy) throw new Error('A scenario needs strategy and swaps');
if (!Number.isInteger(lostAt) || lostAt < 1 || lostAt > scenario.swaps.length) throw new Error('--lost-at must name one of the chosen swaps');
const source = openProto(options.proto), { pinned } = source;
const parent = join(repo, '.test-artifacts/demo'); mkdirSync(parent, { recursive: true });
const artifacts = mkdtempSync(join(parent, 'run-')), snapshot = join(artifacts, 'proto');
const receipt = { scenario: scenario.title ?? options.scenario, fault: options.fault ?? null, simulated: 'provider, chain, settlement and owner wallet signatures are simulated; no real funds or credentials', steps: [] };
const prompt = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;

let step = 0;
async function beat(actor, title) {
  step++;
  console.log(`\n── Step ${step} · ${actor} · ${title}`);
  if (options.pause && prompt) await prompt.question('   (Enter to continue) ');
}
const record = entry => { receipt.steps.push({ step, ...entry }); return entry; };
/** The legs the owner chose, in a comparable form: from, to, amount. */
const legs = list => list.map(({ from, to, amount }) => JSON.stringify({ from, to, amount }));
const sameLegs = (actual, expected) => JSON.stringify([...legs(actual)].sort()) === JSON.stringify([...legs(expected)].sort());
const total = list => list.reduce((sum, leg) => sum + BigInt(leg.amount), 0n).toString();
/** The access the owner grants at the consent page: these scopes and no others. */
const SCOPES = ['execute-plan', 'prepare', 'read'];
const show = (label, value) => console.log(`   ${label}: ${value}`);

source.copy(snapshot);
const skill = join(repo, 'skills/treasury');
// The packaged skill helper by default; `--helper` runs another implementation of the same commands, recorded as such.
const helperFile = resolve(options.helper ?? join(skill, 'scripts/treasury.mjs'));
receipt.provenance = { node: process.version, treasurySkill: digest(skill),
  helper: { file: helperFile, sha256: createHash('sha256').update(readFileSync(helperFile)).digest('hex'), packaged: !options.helper }, ...source.provenance(snapshot) };

console.log(`Treasury strategy demo · artifacts ${artifacts}`);
console.log('SIMULATED: provider, chain, settlement and owner wallet. No real funds, credentials or signatures.');
if (pinned) console.log(`Proto: pinned snapshot ${pinned.runDigest} (verified)`);
const { offlineEnvironment } = await import(join(snapshot, 'scripts/test-environment.mjs'));
source.build(snapshot, artifacts, offlineEnvironment());

const { environment } = await import(join(snapshot, 'test/e2e/environment.mjs'));
const { browserContext } = await import(join(snapshot, 'test/e2e/wallet.mjs'));
const { PAYEE } = await import(join(snapshot, 'test/e2e/provider.mjs'));
const { stackControls } = await import(join(snapshot, 'test/e2e/stack-controls.mjs'));
const { chromium } = createRequire(join(snapshot, 'package.json'))('@playwright/test');
const stack = await environment(join(artifacts, 'environment'), { workspace: true });
const controls = stackControls(stack, { owner: PAYEE });
const browser = await chromium.launch({ headless: !options.headed, slowMo: options.headed ? 250 : 0 });
let token, boundDigest, ok = false, declined = false;
// Simulated provider submissions are counted from the start: dry quotes never enter this log.
const start = stack.portfolio.swaps.length;
const submitted = () => stack.portfolio.swaps.slice(start);
const env = () => ({ ...offlineEnvironment(), NODE_OPTIONS: `--require ${JSON.stringify(join(snapshot, 'test/fixtures/offline-network.cjs'))}`,
  NODE_EXTRA_CA_CERTS: join(stack.directory, 'localhost.crt'), TREASURY_URL: stack.dashboard, TREASURY_NAME: 'portfolio', TREASURY_MACHINE_TOKEN: token });
/** One actual helper command. Output is kept privately in the run directory; the token never is. */
function helper(...args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [helperFile, ...args], { env: env() });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', fail);
    child.once('close', code => {
      // Redact before anything is written; a leak still fails the run.
      const leaked = Boolean(token) && (stdout.includes(token) || stderr.includes(token));
      const redact = text => token ? text.replaceAll(token, '[credential]') : text;
      stdout = redact(stdout); stderr = redact(stderr);
      const output = stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
      writeFileSync(join(artifacts, `step-${step}-${args[0]}.json`), JSON.stringify({ args, code, output, stderr }, null, 2));
      if (leaked) return fail(new Error('Helper output contained the credential'));
      done({ code, output, stderr: stderr.trim() });
    });
  });
}
const human = async question => {
  if (options.yes) { console.log(`   ${question} → yes (--yes)`); return true; }
  if (!prompt) { console.log(`   ${question} → declined (no terminal; pass --yes)`); return false; }
  return /^y(es)?$/i.test((await prompt.question(`   ${question} [y/N] `)).trim());
};

try {
  await beat('Owner (simulated prior setup)', 'Strategy in force');
  // The same offline owner-strategy fixture Proto's agent-access E2E uses; its autopilot ceiling stays zero.
  mkdirSync(join(stack.directory, 'portfolio/.strategy'), { recursive: true });
  writeFileSync(join(stack.directory, 'portfolio/.strategy/.env.json'), JSON.stringify({ ...scenario.strategy, autopilot: { everyMin: 60, maxUsd: 0 } }));
  record({ actor: 'owner', action: 'strategy fixture written', simulated: true, strategy: scenario.strategy });
  show('targets (bps)', JSON.stringify(scenario.strategy.targetBps));

  await beat('Owner (simulated signature)', 'Authorize the saved strategy: a grant bound to its digest');
  // Machine-credential plans run only under the owner's grant for the saved strategy (`treasury:<suffix>`). Proto's control
  // prepares `grant_issue` with `expectedStrategyDigest` through the owner's route and signs it with the fixture key.
  if (unbound) {
    record({ actor: 'owner', action: 'strategy-bound grant not signed (fault)', simulated: true });
    console.log('   SIMULATED FAULT: the owner skips this step; the live grant stays a plain `treasury` grant.');
  } else {
    ({ digest: boundDigest } = await controls.authorizeStrategy());
    record({ actor: 'owner', action: 'strategy-bound grant signed', simulatedSignature: true, strategyDigest: boundDigest });
    show('grant binds strategy', boundDigest);
  }

  await beat('Owner (human decision)', 'Grant scoped agent access at Proto’s shared consent page');
  const wallet = await browserContext(browser, stack, PAYEE);
  const page = await wallet.context.newPage();
  await page.goto(`${stack.dashboard}/a/portfolio/access`);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByLabel('Access label').fill(scenario.access?.label ?? 'Treasury strategy demo');
  await page.getByRole('checkbox', { name: 'Prepare plans' }).check();
  await page.getByRole('checkbox', { name: 'Execute saved plans' }).check();
  await page.getByRole('button', { name: 'Review access', exact: true }).click();
  await page.getByRole('button', { name: 'Grant access', exact: true }).click();
  const secret = page.getByLabel('Access credential');
  await secret.waitFor();
  token = await secret.inputValue();
  const [credential] = await page.evaluate(async () => (await (await fetch('/gw/machine-credentials/portfolio')).json()).credentials);
  record({ actor: 'owner', action: 'machine credential issued', simulatedSignature: true, credentialId: credential.id, scopes: credential.scopes, expiresAt: credential.expiresAt });
  if (JSON.stringify([...credential.scopes].sort()) !== JSON.stringify(SCOPES)) throw new Error(`The credential's scopes are ${credential.scopes.join(', ')}, not exactly ${SCOPES.join(', ')}`);
  show('credential', `${credential.id} · scopes ${credential.scopes.join(', ')} · no separate spending budget`);

  await beat('Agent', 'Observe holdings, budget, strategy and unresolved operations');
  const [overview] = (await helper('inspect')).output;
  const [strategy] = (await helper('strategy')).output;
  const [unresolvedBefore] = (await helper('unresolved')).output;
  for (const h of overview.book) show(h.symbol, `${h.confidential} confidential + ${h.public} public (atomic units)`);
  const daily = overview.policy?.usage?.budget?.daily;
  show('daily budget left (USD)', daily?.remaining_usd ?? 'unavailable');
  show('unresolved operations', unresolvedBefore.length);
  record({ actor: 'agent', action: 'observed', book: overview.book.map(({ symbol, public: open, confidential }) => ({ symbol, public: open, confidential })),
    budget: overview.policy?.usage?.budget ?? null, strategyDigest: strategy?.digest ?? null, unresolved: unresolvedBefore.length });
  if (unresolvedBefore.length) throw new Error('Unresolved operations block new sends; stop and inspect them first');
  if (!unbound && strategy?.digest !== boundDigest) throw new Error('The saved strategy is not the one the owner authorized; machine plans would be refused');

  await beat('Agent', 'Choose swaps and quote them as one saved plan (externalPlan, never rebalance)');
  const swapsFile = join(artifacts, 'chosen-swaps.json');
  writeFileSync(swapsFile, JSON.stringify({ swaps: scenario.swaps }));
  const prepared = await helper('prepare', swapsFile);
  if (prepared.code !== 0) {
    // The simulator quotes only the pairs it declares; its refusals are not policy decisions.
    record({ actor: 'agent', action: 'preparation refused; nothing saved or sent', error: prepared.stderr, simulatorErrors: stack.portfolio.errors });
    throw new Error(`Preparation refused: ${prepared.stderr}${stack.portfolio.errors.length ? ` Simulated provider: ${stack.portfolio.errors.join('; ')}` : ''}`);
  }
  const [plan] = prepared.output;
  if (!sameLegs(plan.actions, scenario.swaps) || plan.actions.length !== scenario.swaps.length) throw new Error('The saved plan does not hold exactly the chosen swaps');
  if (submitted().length) throw new Error(`${submitted().length} provider submissions before execution was authorized`);
  for (const [i, action] of plan.actions.entries()) show(`swap ${i + 1}`, `${action.amount} ${action.from} → ${action.to}, minimum ${action.minAmountOut}`);
  show('plan', `${plan.id} · source ${plan.source} · expires ${plan.expiresAt}`);
  record({ actor: 'agent', action: 'plan saved', planId: plan.id, source: plan.source, expiresAt: plan.expiresAt, actions: plan.actions });

  await beat('Owner (human decision)', 'Authorize execution of this exact saved plan');
  const authorized = await human(`Execute plan ${plan.id}?`);
  if (submitted().length) throw new Error(`${submitted().length} provider submissions during the owner's decision`);
  if (!authorized) {
    declined = true;
    record({ actor: 'owner', action: 'execution not authorized', submissions: submitted().length });
    console.log('   Stopped before execution. The plan expires unused; nothing was submitted.');
  } else {
    record({ actor: 'owner', action: 'execution authorized', planId: plan.id, submissionsBefore: submitted().length });
    await beat('Agent', 'Execute the saved plan once');
    if (lost) stack.portfolio.dropSwapResponse(lostAt);
    if (lost) console.log(`   SIMULATED FAULT: the provider's response to swap ${lostAt} is lost after it was accepted.`);
    const executed = await helper('execute', plan.id);
    for (const event of executed.output) show(`action ${event.index ?? '?'}`, `${event.type} ${event.status ?? ''} ${event.correlationId ?? ''}`.trim());
    if (executed.code !== 0) show('helper', executed.stderr);
    record({ actor: 'agent', action: 'execution returned', exitCode: executed.code, events: executed.output, error: executed.stderr || null });

    await beat('Agent', 'Observe the exact plan’s recorded outcome and the budget left');
    const [activity] = (await helper('activity')).output;
    const [unresolved] = (await helper('unresolved')).output;
    const [after] = (await helper('inspect')).output;
    // In submission order, which is the plan's order: the activity read lists newest first.
    const operations = activity.filter(op => op.planId === plan.id).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (const op of operations) show(`${op.request?.amount} ${op.request?.origin_asset} → ${op.request?.destination_asset}`, `${op.status ?? (op.refused ? `refused ${op.refused}` : 'outcome unknown')} · ${op.correlationId ?? 'no provider reference'}`);
    show('unresolved operations', unresolved.length);
    const budgetAfter = after?.policy?.usage?.budget ?? null;
    const left = window => !window ? 'unavailable' : window.limit_usd === null ? 'no limit' : window.remaining_usd ?? 'unavailable';
    for (const period of ['daily', 'weekly', 'monthly']) show(`${period} budget left after (USD)`, left(budgetAfter?.[period]));
    console.log('   Budget changes may include other activity; the difference is not attributed to this plan.');
    const sent = submitted(), keys = new Set(sent.map(s => s.key));
    // What the provider received, and what Proto recorded, against the plan's own legs and floors.
    const bodies = sent.map(({ body }) => ({ from: body.origin_asset, to: body.destination_asset, amount: body.amount, minAmountOut: body.min_amount_out }));
    const recorded = operations.map(({ request }) => ({ from: request?.origin_asset, to: request?.destination_asset, amount: request?.amount }));
    const planned = plan.actions.slice(0, unbound ? 0 : lost ? lostAt : plan.actions.length);
    const floorsKept = bodies.every(body => planned.some(action => legs([action])[0] === legs([body])[0] && action.minAmountOut === body.minAmountOut));
    record({ actor: 'agent', action: 'outcome observed', planId: plan.id,
      operations: operations.map(({ kind, request, status, refused, correlationId, at }) => ({ purpose: kind, amount: request?.amount, from: request?.origin_asset, to: request?.destination_asset, status: status ?? null, refused: refused ?? null, correlationId: correlationId ?? null, at })),
      budgetBefore: overview.policy?.usage?.budget ?? null, budgetAfter,
      unresolved: unresolved.map(({ key, kind }) => ({ key, kind })), simulatedSubmissions: sent.length, distinctSubmissionIdentities: keys.size,
      submittedLegs: bodies, submittedTotal: total(bodies), floorsKept });
    const delivered = sameLegs(bodies, planned) && floorsKept && keys.size === sent.length;
    if (unbound) {
      // Refused before the claim: one `rejected` event naming the grant, the helper's guidance, and nothing sent or recorded.
      const [event, ...rest] = executed.output;
      ok = executed.code !== 0 && !rest.length && event?.type === 'rejected' && /grant doesn't bind the saved strategy/.test(event.problems?.join(' ') ?? '') &&
        /^Refused before sending/.test(executed.stderr) && sent.length === 0 && operations.length === 0 && unresolved.length === 0;
    } else if (lost) {
      console.log('   Unknown outcome: the agent stops here. New sends stay blocked; it reports and keeps observing this plan, without replaying it.');
      await beat('Agent (probe)', 'Try to replay the plan, and to start a new action, while the outcome is unknown');
      const replay = await helper('execute', plan.id);
      const afterReplay = submitted().length;
      const fresh = await helper('prepare', swapsFile);
      const freshPlan = fresh.code === 0 ? fresh.output[0] : null;
      const freshExecuted = freshPlan ? await helper('execute', freshPlan.id) : null;
      const probes = { replay: { exitCode: replay.code, error: replay.stderr || null, submissionsAfter: afterReplay },
        newAction: { prepareExitCode: fresh.code, prepareError: fresh.stderr || null, planId: freshPlan?.id ?? null,
          executeExitCode: freshExecuted?.code ?? null, executeError: freshExecuted?.stderr || null, submissionsAfter: submitted().length } };
      show('replay of the same plan', replay.code !== 0 ? `refused: ${replay.stderr}` : 'NOT refused');
      show('a distinct new action', freshExecuted ? (freshExecuted.code !== 0 ? `refused at execution: ${freshExecuted.stderr}` : 'NOT refused') : `refused at preparation: ${fresh.stderr}`);
      record({ actor: 'agent', action: 'unresolved-send block probed', probes });
      const blocked = replay.code !== 0 && afterReplay === sent.length && (freshExecuted ? freshExecuted.code !== 0 : fresh.code !== 0) && submitted().length === sent.length;
      ok = executed.code !== 0 && unresolved.length === 1 && sent.length === lostAt && delivered && blocked;
    } else ok = executed.code === 0 && unresolved.length === 0 && sent.length === scenario.swaps.length && delivered &&
      sameLegs(recorded, scenario.swaps) && operations.length === scenario.swaps.length && operations.every(op => op.status === 'SUCCESS') &&
      total(bodies) === total(scenario.swaps) && budgetAfter?.daily !== undefined;
  }
} catch (error) {
  console.log(`   Stopped: ${error.message}`);
  receipt.stopped = error.message;
} finally {
  prompt?.close(); await browser.close(); await stack.close();
  if (pinned) {
    receipt.provenance.protoSnapshot.unchangedAfterRun = source.unchanged();
    if (!receipt.provenance.protoSnapshot.unchangedAfterRun) ok = false;
  }
  receipt.result = declined && !receipt.stopped ? 'declined' : ok ? 'as expected' : 'unexpected';
  writeFileSync(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(`\nReceipt: ${join(artifacts, 'receipt.json')} (${receipt.result})`);
  process.exitCode = ok ? 0 : 1;
}
