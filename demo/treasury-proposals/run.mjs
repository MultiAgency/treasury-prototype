#!/usr/bin/env node
// Treasury proposals demo (coordination/treasury-app-move.md, stage 6): an outside agent proposes swaps through the
// Treasury app, the owner signs the platform's exact terms and executes them, against an isolated local platform with a
// simulated provider, chain and owner wallet. The platform supplies authority, records and execution; Treasury supplies
// the app server, agent tokens, the skill helper and the owner's approval relay; this recipe supplies scenario inputs,
// the owner's simulated decisions and a receipt.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';
import { digest, openProto } from '../proto-snapshot.mjs';

const here = import.meta.dirname, repo = resolve(here, '../..');
const { values: options } = parseArgs({ options: {
  scenario: { type: 'string', default: join(repo, 'demo/treasury-strategy/scenario.json') },
  proto: { type: 'string', default: process.env.PROTO_DIR ?? resolve(repo, '../proto') },
  fault: { type: 'string' },
} });
if (options.fault && !['lost-response', 'below-floor'].includes(options.fault)) throw new Error('--fault accepts lost-response or below-floor');
const lost = options.fault === 'lost-response', belowFloor = options.fault === 'below-floor';
const scenario = JSON.parse(readFileSync(resolve(options.scenario), 'utf8'));
if (!Array.isArray(scenario.swaps) || !scenario.swaps.length || !scenario.strategy) throw new Error('A scenario needs strategy and swaps');
const source = openProto(options.proto), { pinned } = source;
const parent = join(repo, '.test-artifacts/demo'); mkdirSync(parent, { recursive: true });
const artifacts = mkdtempSync(join(parent, 'proposals-')), snapshot = join(artifacts, 'proto');
const receipt = { scenario: scenario.title ?? options.scenario, fault: options.fault ?? null,
  simulated: 'provider, chain, settlement and owner wallet signatures are simulated; no real funds or credentials', steps: [] };
let step = 0;
const beat = (actor, title) => console.log(`\n── Step ${++step} · ${actor} · ${title}`);
const record = entry => { receipt.steps.push({ step, ...entry }); return entry; };
const show = (label, value) => console.log(`   ${label}: ${value}`);
const ORG = 'org_1', AGENT = 'portfolio', DEPLOYMENT = 'treasury-app';

source.copy(snapshot);
const helperFile = join(repo, 'skills/treasury/scripts/treasury-app.mjs');
receipt.provenance = { node: process.version, treasurySkill: digest(join(repo, 'skills/treasury')), treasuryApp: digest(join(repo, 'app')), ...source.provenance(snapshot) };
console.log(`Treasury proposals demo · artifacts ${artifacts}`);
console.log('SIMULATED: provider, chain, settlement and owner wallet. No real funds, credentials or signatures.');
if (pinned) console.log(`Platform: pinned snapshot ${pinned.runDigest} (verified)`);
const { offlineEnvironment } = await import(join(snapshot, 'scripts/test-environment.mjs'));
source.build(snapshot, artifacts, offlineEnvironment());
const { environment } = await import(join(snapshot, 'test/e2e/environment.mjs'));
const { PAYEE, PUBLIC_KEY } = await import(join(snapshot, 'test/e2e/provider.mjs'));
const { stackControls, appCredential } = await import(join(snapshot, 'test/e2e/stack-controls.mjs'));
const { createAppServer } = await tsImport(join(repo, 'app/server.ts'), import.meta.url);
const { RuntimeTokens } = await tsImport(join(repo, 'app/runtime-tokens.ts'), import.meta.url);
const { treasuryApp } = await tsImport(join(repo, 'app/treasury-app.ts'), import.meta.url);

const stack = await environment(join(artifacts, 'environment'), { workspace: true, selfService: true });
const controls = stackControls(stack, { owner: PAYEE });
const ca = readFileSync(join(stack.directory, 'localhost.crt')), key = readFileSync(join(stack.directory, 'localhost.key'));
const platformHost = new URL(stack.dashboard).host;
// Simulated provider submissions, counted from the start: dry quotes never enter this log.
const start = stack.portfolio.swaps.length, submitted = () => stack.portfolio.swaps.slice(start);

/** HTTPS trusting only the stack's own certificate: the app's calls to the platform, and the owner's to the app. */
const tlsFetch = (input, init = {}) => new Promise((done, fail) => {
  const url = new URL(input instanceof Request ? input.url : input), headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  const req = request(url, { method: init.method ?? (input instanceof Request ? input.method : 'GET'), headers: Object.fromEntries(headers), ca }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)).on('end', () => {
      const answered = new Headers(); for (const [n, v] of Object.entries(res.headers)) for (const one of [v].flat()) answered.append(n, one);
      done(new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: answered }));
    });
  });
  req.on('error', fail);
  (async () => req.end(init.body ?? (input instanceof Request && input.body ? Buffer.from(await input.arrayBuffer()) : undefined)))();
});

let appServer, ok = false;
try {
  beat('Owner (simulated prior setup)', 'Strategy in force');
  mkdirSync(join(stack.directory, 'portfolio/.strategy'), { recursive: true });
  writeFileSync(join(stack.directory, 'portfolio/.strategy/.env.json'), JSON.stringify({ ...scenario.strategy, autopilot: { everyMin: 60, maxUsd: 0 } }));
  record({ actor: 'owner', action: 'strategy fixture written', simulated: true, strategy: scenario.strategy });

  beat('Platform operator', 'Issue the Treasury app\'s deployment credential');
  const credential = await appCredential(stack, DEPLOYMENT);
  record({ actor: 'operator', action: 'app credential issued', deployment: DEPLOYMENT });

  beat('Treasury', 'Start the Treasury app (HTTPS, this run\'s own state)');
  const state = join(artifacts, 'app-state'), secret = randomBytes(32).toString('base64url');
  const platform = treasuryApp({ platform: stack.dashboard, credential, state, fetch: tlsFetch });
  // The stack's owner key is the simulated wallet; its key lookup stands in for the chain's.
  const keyLookup = async (account, publicKey) => account === PAYEE && publicKey === PUBLIC_KEY ? 'FullAccess' : null;
  // The app binds to its own host, port included, so it is created once the HTTPS listener has its port.
  let handler;
  appServer = createServer({ key, cert: ca }, (req, res) => handler(req, res));
  await new Promise(done => appServer.listen(0, '127.0.0.1', done));
  const appHost = `localhost:${appServer.address().port}`;
  handler = createAppServer({ host: appHost, secret, keyLookup, platform, tokens: new RuntimeTokens(join(state, 'tokens')), web: join(repo, 'web/dist') })
    .listeners('request')[0];
  const appOrigin = `https://${appHost}`;
  show('app', appOrigin);
  let cookie;
  const app = async (path, { method = 'GET', body } = {}) => {
    const response = await tlsFetch(`${appOrigin}${path}`, { method, headers: { ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: response.status, body: await response.json() };
  };

  beat('Owner (simulated signature)', 'Sign in to the Treasury app with the wallet');
  const challenge = (await app('/app/challenge')).body;
  const signedIn = await controls.signOwner(challenge);
  const session = await app('/app/session', { method: 'POST', body: { accountId: PAYEE, publicKey: signedIn.publicKey, signature: signedIn.signature, nonce: challenge.nonce } });
  if (session.status !== 200) throw new Error(`Sign-in refused: ${session.body.error}`);
  record({ actor: 'owner', action: 'signed in to the app', simulatedSignature: true, account: session.body.account });

  beat('Owner (simulated signature)', 'Connect the agent in the Treasury app: read + treasury, no unattended execution');
  const prepared = await app('/app/connect/prepare', { method: 'POST', body: { organization: ORG, agent: AGENT, execute: false } });
  if (prepared.status !== 200) throw new Error(`Connect refused: ${prepared.body.error}`);
  if (prepared.body.recipient !== platformHost) throw new Error('The consent recipient is not the platform host');
  const signedConsent = await controls.signOwner({ message: prepared.body.message, recipient: prepared.body.recipient, nonce: prepared.body.nonce });
  const connected = await app('/app/connect', { method: 'POST', body: { nonce: prepared.body.nonce, publicKey: signedConsent.publicKey, signature: signedConsent.signature } });
  if (connected.status !== 201) throw new Error(`Consent refused: ${connected.body.error}`);
  record({ actor: 'owner', action: 'consent signed in the app', simulatedSignature: true, scopes: connected.body.consent.scopes });
  show('consent', connected.body.consent.scopes.join(', '));

  beat('Owner', 'Issue the agent a read + propose token');
  const issued = await app('/app/tokens', { method: 'POST', body: { organization: ORG, agent: AGENT, label: 'Treasury proposals demo', scopes: ['read', 'propose'], ttlSeconds: 3_600 } });
  if (issued.status !== 201) throw new Error(`Token refused: ${issued.body.error}`);
  const token = issued.body.secret;
  record({ actor: 'owner', action: 'agent token issued', scopes: issued.body.token.scopes, expiresAt: issued.body.token.expiresAt });

  /** One actual helper command; its output is kept privately, the token never is. */
  const helper = (...args) => new Promise((done, failed) => {
    const child = spawn(process.execPath, [helperFile, ...args], { env: { ...offlineEnvironment(), NODE_EXTRA_CA_CERTS: join(stack.directory, 'localhost.crt'),
      TREASURY_APP_URL: appOrigin, TREASURY_ORGANIZATION: ORG, TREASURY_AGENT: AGENT, TREASURY_APP_TOKEN: token } });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', failed);
    child.once('close', code => {
      if (stdout.includes(token) || stderr.includes(token)) return failed(new Error('Helper output contained the token'));
      writeFileSync(join(artifacts, `step-${step}-${args[0]}.json`), JSON.stringify({ args, code, stdout, stderr }, null, 2));
      done({ code, value: stdout.trim() ? JSON.parse(stdout).value : undefined, stderr: stderr.trim() });
    });
  });

  beat('Agent', 'Read, then propose the chosen swaps once under its own request ID');
  const unresolved = await helper('unresolved');
  show('unresolved operations', unresolved.value?.length);
  const terms = join(artifacts, 'terms.json');
  writeFileSync(terms, JSON.stringify({ legs: scenario.swaps, expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString().replace('.000Z', 'Z'), note: 'demo: chosen swaps' }));
  const proposed = await helper('propose', terms, '--request-id', 'demo-1');
  if (proposed.code !== 0) throw new Error(`Proposal refused: ${proposed.stderr}`);
  const id = proposed.value.id;
  if (submitted().length) throw new Error('A provider submission before the owner approved');
  for (const [i, leg] of proposed.value.legs.entries()) show(`swap ${i + 1}`, `${leg.amount} ${leg.from} → ${leg.to}, minimum ${leg.minAmountOut}`);
  record({ actor: 'agent', action: 'proposed', id, state: proposed.value.state, legs: proposed.value.legs });

  beat('Owner (simulated signature)', 'Review the proposal and sign its exact text');
  const review = await app(`/app/proposals/${id}?organization=${ORG}&agent=${AGENT}`);
  if (!review.body.sign) throw new Error(`The proposal couldn't be read for review (${review.status}): ${JSON.stringify(review.body).slice(0, 300)}`);
  if (review.body.sign.recipient !== platformHost) throw new Error('The signing recipient is not the platform host');
  const approveNonce = randomBytes(32).toString('base64');
  const signedApproval = await controls.signOwner({ message: review.body.sign.approve, recipient: review.body.sign.recipient, nonce: approveNonce });
  const decided = await app(`/app/proposals/${id}/decide`, { method: 'POST', body: { organization: ORG, agent: AGENT, verdict: 'approve',
    signed: { message: review.body.sign.approve, nonce: approveNonce, publicKey: signedApproval.publicKey, signature: signedApproval.signature } } });
  show('decision', `exit ${decided.body.exit} · ${decided.body.result.value?.state ?? decided.body.result.code}`);
  record({ actor: 'owner', action: 'approved', simulatedSignature: true, exit: decided.body.exit, state: decided.body.result.value?.state ?? null });
  if (submitted().length) throw new Error('A provider submission at approval');

  beat('Owner', 'Execute the approved proposal');
  const execute = () => app(`/app/proposals/${id}/execute`, { method: 'POST', body: { organization: ORG, agent: AGENT } });
  let refusedBelowFloor = null;
  if (belowFloor) {
    stack.portfolio.setPrice('nep141:wrap.near', 3);
    console.log('   SIMULATED FAULT: wNEAR\'s price rises, so each swap would return less than its signed minimum.');
    const refused = await execute();
    refusedBelowFloor = { exit: refused.body.exit, code: refused.body.result.code ?? null, submissions: submitted().length };
    show('below the floor', `exit ${refused.body.exit} · ${refused.body.result.code ?? refused.body.result.value?.state}`);
    stack.portfolio.setPrice('nep141:wrap.near', 2);
  }
  if (lost) { stack.portfolio.dropSwapResponse(1); console.log('   SIMULATED FAULT: the provider\'s response to the first swap is lost after it was accepted.'); }
  const ran = await execute();
  show('execution', `exit ${ran.body.exit} · ${ran.body.result.value?.state ?? ran.body.result.code}`);
  record({ actor: 'owner', action: 'executed', exit: ran.body.exit, state: ran.body.result.value?.state ?? null, belowFloor: refusedBelowFloor });

  beat('Agent', 'Follow the proposal by its ID; never act again');
  const followed = await helper('proposal', id);
  const sent = submitted(), operations = followed.value?.operations ?? [];
  show('proposal state', followed.value?.state);
  for (const op of operations) show(op.method ?? 'swap', `${op.status ?? (op.refused ? `refused ${op.refused}` : 'outcome unknown')} · ${op.correlationId ?? 'no provider reference'}`);
  const bodies = sent.map(({ body }) => ({ from: body.origin_asset, to: body.destination_asset, amount: body.amount, minAmountOut: body.min_amount_out }));
  const floorsKept = bodies.every(b => proposed.value.legs.some(l => l.from === b.from && l.to === b.to && l.amount === b.amount && BigInt(b.minAmountOut) >= BigInt(l.minAmountOut)));
  record({ actor: 'agent', action: 'followed', state: followed.value?.state ?? null, exit: followed.code, operations, simulatedSubmissions: sent.length, submittedLegs: bodies, floorsKept });
  if (lost) {
    // An unknown outcome: the owner does not execute again; a second attempt must send nothing.
    const again = await execute();
    record({ actor: 'owner (probe)', action: 'execute again while unknown', exit: again.body.exit, state: again.body.result.value?.state ?? null, submissionsAfter: submitted().length });
    ok = ran.body.exit === 3 && followed.value?.state === 'unknown' && submitted().length === sent.length && sent.length >= 1 && floorsKept;
  } else ok = ran.body.exit === 0 && followed.value?.state === 'executed' && sent.length === scenario.swaps.length && floorsKept &&
    operations.every(op => op.status === 'SUCCESS') && (!belowFloor || (refusedBelowFloor?.exit === 2 && refusedBelowFloor.code === 'not_executable' && refusedBelowFloor.submissions === 0));
} catch (error) {
  console.log(`   Stopped: ${error.message}`);
  receipt.stopped = error.message;
} finally {
  appServer?.close(); await stack.close();
  if (pinned) {
    receipt.provenance.protoSnapshot.unchangedAfterRun = source.unchanged();
    if (!receipt.provenance.protoSnapshot.unchangedAfterRun) ok = false;
  }
  receipt.result = ok ? 'as expected' : 'unexpected';
  writeFileSync(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(`\nReceipt: ${join(artifacts, 'receipt.json')} (${receipt.result})`);
  process.exitCode = ok ? 0 : 1;
}
