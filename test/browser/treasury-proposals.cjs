/** The Treasury app's owner page (web/'s `proposals` entry) against fixture /app routes and an offline wallet. */
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runTask } = require('./fixtures/task.cjs');
const { assertAccessible } = require('./fixtures/accessibility.cjs');

const ID = '7d3c1f0e2b4a4c5d8e6f1a2b3c4d5e6f', PLATFORM = 'platform.example';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', WNEAR = 'nep141:wrap.near';
// The platform's text, as the app server returns it: the page must show and sign it unchanged.
const APPROVE = `Approve Treasury proposal ${ID}\nAgent agent-1\nProposed by treasury-app for org_1\n1. Swap 1 USDC (1000000) for at least 0.49 wNEAR (490000000000000000000000)`;
const REJECT = APPROVE.replace('Approve', 'Reject');
// The app's prepared consent text (the SDK's canonical JSON): the page must show and sign it unchanged.
const CONSENT = JSON.stringify({ type: 'multiagency-app-consent', version: 1, host: PLATFORM, deployment: 'treasury-app', organization: 'org_1', owner: 'owner.near', agent: 'portfolio', agentId: 'agent-1', scopes: ['read', 'treasury'], expiresAt: '2026-12-03T00:00:00.000Z' });
const view = state => ({ id: ID, requestId: 'req-1', agentId: 'agent-1', deployment: 'treasury-app', organization: 'org_1', source: 'external',
  legs: [{ from: USDC, to: WNEAR, amount: '1000000', minAmountOut: '490000000000000000000000' }],
  quoted: [{ amountOut: '500000000000000000000000', costBps: 5, usdIn: 1 }], policyRevision: 3, policyDigest: 'a'.repeat(64),
  strategyDigest: `sha256:${'b'.repeat(64)}`, createdAt: '2026-11-03T00:00:00.000Z', expiresAt: '2030-11-05T00:00:00.000Z', note: 'rebalance toward targets',
  sha256: 'c'.repeat(64), state, reason: null, approvedAt: null, planId: null, operations: [] });

async function open(browser, root, { execute = { exit: 0, result: { ok: true, value: view('executed') } }, width = 1280, connected = true, loseConnect = 0, decide = 'answer', signedInAs = 'owner.near' } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    localStorage.setItem('member:selected-wallet:mainnet', 'fixture-wallet');
    window.signed = [];
    const accounts = [{ accountId: 'owner.near', publicKey: 'ed25519:11111111111111111111111111111111' }];
    const wallet = { manifest: { id: 'fixture-wallet', name: 'Offline wallet', features: { signMessage: true, signDelegateActions: true }, permissions: {} },
      getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {},
      signMessage: async ({ message, recipient, nonce }) => {
        window.signed.push({ message, recipient, nonce: btoa(String.fromCharCode(...nonce)) });
        return { accountId: 'owner.near', publicKey: 'ed25519:11111111111111111111111111111111', signature: 'ed25519:fixture-signature' };
      },
      signAndSendTransaction: async () => { throw Error('Unexpected onchain action'); } };
    window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
  });
  const writes = [], errors = [];
  let account = null, state = 'proposed';
  const tokens = [];
  const consent = { id: 'd'.repeat(64), scopes: ['read', 'treasury'], expiresAt: Date.parse('2030-01-01T00:00:00Z'), revoked: false };
  const prepared = { message: CONSENT, recipient: PLATFORM, nonce: Buffer.alloc(32, 5).toString('base64'), scopes: ['read', 'treasury'] };
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const request = route.request(), { hostname, pathname: p } = new URL(request.url());
    if (hostname !== 'app.test') return route.abort();
    if (p === '/app/me') return account ? route.fulfill({ json: { account } }) : route.fulfill({ status: 401, json: { error: 'Sign in first' } });
    if (p === '/app/challenge') return route.fulfill({ json: { message: 'Sign in to app.test', recipient: 'app.test', nonce: Buffer.alloc(32, 1).toString('base64') } });
    if (p === '/app/session') { writes.push('session'); account = signedInAs; return route.fulfill({ json: { account } }); }
    if (p === '/app/connect' && request.method() === 'GET') return route.fulfill({ json: { consents: connected ? [consent] : [] } });
    if (p === '/app/connect/prepare') { writes.push({ prepare: request.postDataJSON() }); return route.fulfill({ json: prepared }); }
    if (p === '/app/connect' && request.method() === 'POST') {
      writes.push({ connect: request.postDataJSON() });
      if (loseConnect > 0) { loseConnect--; return route.fulfill({ status: 503, json: { error: 'The platform didn\'t answer. Submit the same signature again; it is the same consent.' } }); }
      connected = true; return route.fulfill({ status: 201, json: { consent } });
    }
    if (p === '/app/tokens' && request.method() === 'GET') return route.fulfill({ json: { tokens } });
    if (p === '/app/tokens' && request.method() === 'POST') {
      const body = request.postDataJSON(); writes.push({ issue: body });
      const token = { id: '0f0e0d0c-0b0a-4090-8070-605040302010', label: body.label, scopes: body.scopes, expiresAt: Date.now() + body.ttlSeconds * 1000, revoked: false };
      tokens.push(token); return route.fulfill({ status: 201, json: { token, secret: `tat_${token.id}.${'S'.repeat(43)}` } });
    }
    if (p.startsWith('/app/tokens/') && request.method() === 'DELETE') { writes.push({ revoke: p.split('/').at(-1) }); tokens.forEach(t => { t.revoked = true; }); return route.fulfill({ json: { revoked: true } }); }
    if (p === '/app/orders/access') return route.fulfill({ json: { capable: false, consented: false, owner: 'owner.near', signer: 'wallet', mayRead: false, mayPrepare: false, mayExecute: false, mayVote: false, mayConsent: false } });
    if (p === '/app/proposals') return route.fulfill({ json: { exit: 0, result: { ok: true, value: { proposals: [view(state)] } } } });
    if (p === `/app/proposals/${ID}`) return route.fulfill({ json: { exit: 0, result: { ok: true, value: view(state) }, sign: { recipient: PLATFORM, approve: APPROVE, reject: REJECT } } });
    if (p === `/app/proposals/${ID}/decide`) {
      const body = request.postDataJSON(); writes.push({ decide: body });
      if (decide === 'abort') return route.abort();
      state = body.verdict === 'approve' ? 'approved' : 'rejected';
      return route.fulfill({ json: { exit: 0, result: { ok: true, value: view(state) } } });
    }
    if (p === `/app/proposals/${ID}/execute`) {
      writes.push('execute');
      if (execute === 'abort') return route.abort();
      if (execute.result.ok) state = execute.result.value.state;
      return route.fulfill({ json: execute });
    }
    if (p.startsWith('/app/')) throw new Error(`Unexpected app route ${p}`);
    return route.fulfill({ path: p.startsWith('/static/') ? join(root, p) : join(root, 'proposals.html'),
      contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : p.startsWith('/static/') ? 'font/woff2' : 'text/html' });
  });
  await page.goto('http://app.test/?organization=org_1&agent=portfolio');
  return { page, writes, errors };
}

async function proposalsApproveExecute(browser, root) {
  const { page, writes, errors } = await open(browser, root);
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).click();
  await page.getByRole('region', { name: 'Proposals' }).waitFor();
  assert.deepEqual(writes, ['session'], 'signing in is the only write so far');
  assert.equal((await page.evaluate(() => window.signed)).length, 1, 'only the sign-in text was signed');
  const list = page.getByRole('region', { name: 'Proposals' });
  await list.getByText('1 USDC → wNEAR', { exact: true }).waitFor();
  await list.getByText("Proposer's note (the agent's words, not checked): rebalance toward targets", { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review proposal', exact: true }).click();
  const review = page.getByRole('region', { name: 'Proposal' });
  await review.getByText('1. Swap 1 USDC for at least 0.49 wNEAR', { exact: true }).waitFor();
  assert.equal(await review.getByRole('figure', { name: 'If you approve, you sign' }).locator('pre').innerText(), APPROVE, 'the approve text is shown verbatim');
  assert.equal(await review.getByRole('figure', { name: 'If you reject, you sign' }).locator('pre').innerText(), REJECT, 'so is the reject text');
  await page.mouse.move(0, 0); // the resting state: the shared theme's button hover is a recorded contrast gap
  await assertAccessible(page, 'proposal review');
  await review.getByRole('button', { name: 'Sign and approve', exact: true }).click();
  await review.getByRole('button', { name: 'Execute', exact: true }).waitFor();
  const signed = (await page.evaluate(() => window.signed))[1];
  assert.deepEqual([signed.message, signed.recipient], [APPROVE, PLATFORM], 'the wallet signs the platform text for the platform host');
  const decided = writes.find(w => w.decide).decide;
  assert.deepEqual(decided, { organization: 'org_1', agent: 'portfolio', verdict: 'approve',
    signed: { message: APPROVE, nonce: signed.nonce, publicKey: 'ed25519:11111111111111111111111111111111', signature: 'ed25519:fixture-signature' } });
  assert.equal(Buffer.from(signed.nonce, 'base64').length, 32);
  assert(!writes.includes('execute'), 'approving does not execute');
  await review.getByRole('button', { name: 'Execute', exact: true }).click();
  assert(!writes.includes('execute'), 'Execute asks for a confirmation first');
  await review.getByRole('button', { name: 'Execute on mainnet now', exact: true }).click();
  // "Done." is already showing from the approval: wait for the executed state before checking focus.
  await review.getByText('executed', { exact: true }).waitFor();
  await page.getByRole('status', { name: 'Outcome' }).getByText('Done.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Outcome', 'focus moves to the outcome after Execute');
  assert.equal(writes.filter(w => w === 'execute').length, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow on mobile');
  assert.deepEqual(errors, []);
}

async function proposalsUnknown(browser, root) {
  const unknown = { exit: 3, result: { ok: true, value: view('unknown') } };
  const { page, writes, errors } = await open(browser, root, { execute: unknown, width: 390 });
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Review proposal', exact: true }).click();
  const review = page.getByRole('region', { name: 'Proposal' });
  await review.getByRole('button', { name: 'Sign and approve', exact: true }).click();
  await review.getByRole('button', { name: 'Execute', exact: true }).click();
  await review.getByRole('button', { name: 'Execute on mainnet now', exact: true }).click();
  await page.getByRole('status', { name: 'Outcome' }).getByText(/outcome is unknown.*Don't execute again/).waitFor();
  assert.equal(await review.getByRole('button', { name: 'Execute', exact: true }).count(), 0, 'an unknown outcome offers no second Execute');
  await page.getByRole('button', { name: 'Read again', exact: true }).click();
  assert.equal(writes.filter(w => w === 'execute').length, 1, 'reading again never executes');
  assert.deepEqual(errors, []);
}

async function proposalsOpenSignsNothing(browser, root) {
  const { page, writes } = await open(browser, root);
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).waitFor();
  assert.deepEqual(writes, []);
  assert.deepEqual(await page.evaluate(() => window.signed), []);
}

async function proposalsConnect(browser, root) {
  const { page, writes, errors } = await open(browser, root, { connected: false, loseConnect: 1 });
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).click();
  const connect = page.getByRole('region', { name: 'Connect' });
  await connect.getByRole('heading', { name: 'Connect portfolio to the Treasury app', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Proposals' }).count(), 0, 'no proposals before the agent is connected');
  assert.equal(await connect.getByRole('checkbox').isChecked(), false, 'unattended execution is off unless the owner ticks it');
  await connect.getByRole('button', { name: 'Review the consent', exact: true }).click();
  assert.deepEqual(writes.find(w => w.prepare).prepare, { organization: 'org_1', agent: 'portfolio', execute: false, days: 30 });
  assert.equal(await connect.getByRole('figure', { name: 'Consent you sign' }).locator('pre').innerText(), CONSENT, 'the prepared text is shown verbatim');
  // The resting state: the pointer left over the new primary button would measure its hover colour, which is 3.74:1
  // in the shared Treasury theme (#733e0a on #daa102), below 4.5:1. That theme gap is recorded separately.
  await page.mouse.move(0, 0);
  await assertAccessible(page, 'connect');
  await connect.getByRole('button', { name: 'Sign and connect', exact: true }).click();
  // The first submission gets no answer: the page offers the same signature again, and signs nothing new.
  await connect.getByRole('button', { name: 'Submit the same signature again', exact: true }).click();
  await page.getByRole('region', { name: 'Proposals' }).waitFor();
  const signed = (await page.evaluate(() => window.signed)).slice(1);
  assert.deepEqual(signed, [{ message: CONSENT, recipient: PLATFORM, nonce: Buffer.alloc(32, 5).toString('base64') }], 'one wallet signature over the exact text, for the platform host');
  const submitted = writes.filter(w => w.connect).map(w => w.connect);
  assert.deepEqual(submitted, Array(2).fill({ nonce: Buffer.alloc(32, 5).toString('base64'), publicKey: 'ed25519:11111111111111111111111111111111', signature: 'ed25519:fixture-signature' }));
  await page.getByRole('region', { name: 'Connection' }).getByText(/Connected: read, treasury/).waitFor();
  assert.deepEqual(errors, []);
}

/** Approve, then reach the confirmed Execute. */
async function approveAndExecute(page) {
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Review proposal', exact: true }).click();
  const review = page.getByRole('region', { name: 'Proposal' });
  await review.getByRole('button', { name: 'Sign and approve', exact: true }).click();
  await review.getByRole('button', { name: 'Execute', exact: true }).click();
  await review.getByRole('button', { name: 'Execute on mainnet now', exact: true }).click();
  return review;
}

/** An execution with no answer, or an unknown answer without the proposal: still approved, but never Execute again. */
function executeHeld(execute, label) {
  const scenario = async (browser, root) => {
    const { page, writes, errors } = await open(browser, root, { execute });
    const review = await approveAndExecute(page);
    await page.getByRole('status', { name: 'Outcome' }).getByText(/may still be running.*Don't execute again/).waitFor();
    await review.getByText(/still reads approved, but your execution got no answer/).waitFor();
    assert.equal(await review.getByRole('button', { name: 'Execute', exact: true }).count(), 0, 'no Execute while the outcome is unknown');
    await page.getByRole('button', { name: 'Read again', exact: true }).click();
    await review.getByText(/still reads approved/).waitFor();
    assert.equal(await review.getByRole('button', { name: 'Execute', exact: true }).count(), 0, 'reading again while still approved keeps it held');
    assert.equal(writes.filter(w => w === 'execute').length, 1);
    assert.deepEqual(errors, []);
  };
  Object.defineProperty(scenario, 'name', { value: `proposalsExecuteHeld_${label}` });
  return scenario;
}

async function proposalsReject(browser, root) {
  const { page, writes, errors } = await open(browser, root);
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Review proposal', exact: true }).click();
  await page.getByRole('region', { name: 'Proposal' }).getByRole('button', { name: 'Sign and reject', exact: true }).click();
  await page.getByRole('region', { name: 'Proposal' }).getByText('rejected', { exact: true }).waitFor();
  const signed = (await page.evaluate(() => window.signed))[1];
  assert.deepEqual([signed.message, signed.recipient], [REJECT, PLATFORM], 'rejecting signs the reject text that was shown');
  assert.equal(writes.find(w => w.decide).decide.verdict, 'reject');
  assert(!writes.includes('execute'));
  assert.deepEqual(errors, []);
}

async function proposalsDecisionNoAnswer(browser, root) {
  const { page, writes } = await open(browser, root, { decide: 'abort' });
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Review proposal', exact: true }).click();
  const review = page.getByRole('region', { name: 'Proposal' });
  await review.getByRole('button', { name: 'Sign and approve', exact: true }).click();
  await page.getByRole('status', { name: 'Outcome' }).getByText(/your decision may have been recorded\. Nothing moves at a decision/).waitFor();
  assert.equal(await page.getByText(/something may have moved/).count(), 0, 'a decision never claims money moved');
  assert.equal(await review.getByRole('button', { name: 'Sign and approve', exact: true }).count(), 0, 'no second signature before reading again');
  await page.getByRole('button', { name: 'Read again', exact: true }).click();
  await review.getByRole('button', { name: 'Sign and approve', exact: true }).waitFor();
  assert.equal(writes.filter(w => w.decide).length, 1);
}

async function proposalsTokens(browser, root) {
  const { page, writes, errors } = await open(browser, root);
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).click();
  const tokens = page.getByRole('region', { name: 'Agent tokens' });
  await tokens.getByLabel('Label').fill('research assistant');
  await tokens.getByRole('button', { name: 'Issue token', exact: true }).click();
  await tokens.getByRole('figure', { name: /shown once/ }).getByText(/^tat_/).waitFor();
  assert.deepEqual(writes.find(w => w.issue).issue, { organization: 'org_1', agent: 'portfolio', label: 'research assistant', scopes: ['read', 'propose'], ttlSeconds: 3600 });
  await page.mouse.move(0, 0);
  await assertAccessible(page, 'tokens');
  await tokens.getByRole('button', { name: 'Revoke research assistant', exact: true }).click();
  await tokens.getByRole('figure').waitFor({ state: 'detached' });
  assert.deepEqual(writes.filter(w => w.revoke).map(w => w.revoke), ['0f0e0d0c-0b0a-4090-8070-605040302010']);
  assert.deepEqual(errors, []);
}

async function proposalsConsentCopy(browser, root) {
  const { page } = await open(browser, root, { connected: false });
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).click();
  const connect = page.getByRole('region', { name: 'Connect' });
  await connect.getByText("No swap runs unless you sign that proposal's exact terms and execute it.", { exact: false }).waitFor();
  await connect.getByRole('checkbox').check();
  await connect.getByText('without your signature on each swap', { exact: false }).first().waitFor();
  assert.equal(await connect.getByText('No swap runs unless', { exact: false }).count(), 0, 'the promise is withdrawn once unattended execution is ticked');
}

async function proposalsWrongWalletAccount(browser, root) {
  // Signed in as someone.near, while the wallet is now on owner.near: nothing is signed or relayed.
  const { page, writes } = await open(browser, root, { signedInAs: 'someone.near' });
  await page.getByRole('button', { name: 'Connect wallet and sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Review proposal', exact: true }).click();
  await page.getByRole('region', { name: 'Proposal' }).getByRole('button', { name: 'Sign and approve', exact: true }).click();
  await page.getByText(/Your wallet is on owner\.near; switch it to someone\.near.*Nothing was signed/).waitFor();
  assert.equal((await page.evaluate(() => window.signed)).length, 1, 'only the sign-in text was signed');
  assert(!writes.some(w => w.decide));
}

runTask([proposalsWrongWalletAccount, proposalsApproveExecute, proposalsUnknown, proposalsOpenSignsNothing, proposalsConnect, executeHeld('abort', 'noAnswer'),
  executeHeld({ exit: 3, result: { ok: false, kind: 'unknown' } }, 'unknownWithoutProposal'), proposalsReject, proposalsDecisionNoAnswer, proposalsTokens, proposalsConsentCopy]);
