/** Offline owner-order UI; fixture routes and wallet never contact a platform or provider. */
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { mkdirSync } = require('node:fs');
const { runTask } = require('./fixtures/task.cjs');
const { assertAccessible } = require('./fixtures/accessibility.cjs');
const ID = '8d3c1f0e2b4a4c5d8e6f1a2b3c4d5e6f', PLATFORM = 'platform.example';
const BASE = 'nep141:wrap.near', QUOTE = 'nep141:usdc.near';
const APPROVE = `Approve Treasury limit order ${ID}\nAgent agent-1\nProposed by treasury-app for org_1\nOrder: sell 1000000 atomic units of ${BASE} at price 2.125 ${QUOTE} per base unit\nDeadline 2030-01-01T00:00:00.000Z; confidential true\nGross spend 1000000 atomic units of ${BASE}; output asset ${QUOTE}\nUnder policy revision 3 (${'a'.repeat(64)}), strategy sha256:${'b'.repeat(64)}\nValid until 2030-01-01T00:00:00.000Z. Order sha256 ${'c'.repeat(64)}.`;
const REJECT = APPROVE.replace('Approve', 'Reject');
const CONSENT = JSON.stringify({ type: 'multiagency-app-consent', version: 1, host: PLATFORM, deployment: 'treasury-app', organization: 'org_1', owner: 'owner.near', agent: 'portfolio', agentId: 'agent-1', scopes: ['read', 'treasury', 'treasury-orders'], expiresAt: '2030-01-01T00:00:00.000Z' });
const initialView = (state = 'proposed') => ({ id: ID, requestId: 'order-1', agentId: 'agent-1', deployment: 'treasury-app', organization: 'org_1', order: { base_asset: BASE, quote_asset: QUOTE, side: 'sell', quantity: '1000000', price: '2.125', deadline: '2030-01-01T00:00:00.000Z', confidential: true }, spendAsset: BASE, spendAmount: '1000000', outputAsset: QUOTE, policyRevision: 3, policyDigest: 'a'.repeat(64), strategyDigest: `sha256:${'b'.repeat(64)}`, createdAt: '2026-11-11T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z', note: null, sha256: 'c'.repeat(64), state, reason: null, approvedAt: null, correlationId: null, orderId: null, fillStatus: null, payoutStatus: null, isPayoutStatusFinal: null, partialFills: null, payouts: null, cancelRequestedAt: null, operation: null });
const answer = value => ({ exit: 0, result: { ok: true, value } });
async function open(browser, root, options = {}) {
  const page = await browser.newPage({ viewport: { width: options.width ?? 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  await page.addInitScript(({ walletAccount, localCancelClaim, orderId }) => {
    localStorage.setItem('member:selected-wallet:mainnet', 'fixture-wallet');
    if (localCancelClaim) localStorage.setItem(`treasury-orders:org_1:portfolio:${orderId}:cancel`, 'saved-cancellation-claim');
    window.signed = []; window.transactions = [];
    const accounts = [{ accountId: walletAccount, publicKey: 'ed25519:11111111111111111111111111111111' }];
    const wallet = { manifest: { id: 'fixture-wallet', name: 'Offline wallet', features: { signMessage: true, signDelegateActions: true }, permissions: {} }, getAccounts: async () => accounts, signIn: async () => accounts, signOut: async () => {},
      signMessage: async ({ message, recipient, nonce }) => { window.signed.push({ message, recipient, nonce: btoa(String.fromCharCode(...nonce)) }); return { accountId: walletAccount, publicKey: accounts[0].publicKey, signature: 'ed25519:fixture-signature' }; },
      signAndSendTransaction: async transaction => { window.transactions.push(transaction); return { status: { SuccessValue: '' } }; } };
    window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet })));
  }, { walletAccount: options.walletAccount ?? 'owner.near', localCancelClaim: options.localCancelClaim ?? false, orderId: ID });
  const writes = [], reads = [], errors = [];
  const decisions = [...(options.decisions ?? [])], orderReads = [...(options.orderReads ?? [])], refreshes = [...(options.refreshes ?? [])];
  let consented = options.consented ?? true;
  let view = { ...initialView(options.state), ...options.view };
  let createLost = options.createLost ?? false, daoPolls = 0;
  page.on('pageerror', e => errors.push(e.message));
  const access = { capable: options.capable ?? true, consented, owner: options.dao ? 'team.sputnik-dao.near' : 'owner.near', signer: options.dao ? 'dao' : 'wallet', mayRead: true, mayPrepare: options.prepare ?? true, mayExecute: options.execute ?? true, mayVote: options.vote ?? true, mayConsent: options.prepare ?? true };
  const filed = { request: { id: 'f'.repeat(64), dao: access.owner, order: ID, hash: 'e'.repeat(64), description: APPROVE, votingUntil: Date.parse('2030-01-01T00:00:00Z'), verdict: 'approve' }, transactions: { proposal: { receiverId: access.owner, actions: [{ type: 'FunctionCall', params: { methodName: 'add_proposal', args: { fixture: 'proposal' }, gas: '300000000000000', deposit: '1' } }] }, proposalAndVote: { receiverId: access.owner, actions: [{ type: 'FunctionCall', params: { methodName: 'add_proposal_and_vote', args: { fixture: 'proposalAndVote' }, gas: '300000000000000', deposit: '1' } }] } } };
  const handleRoute = async route => {
    const req = route.request(), { hostname, pathname: p } = new URL(req.url());
    if (hostname !== 'localhost') return route.abort();
    if (p === '/app/me') return route.fulfill({ json: { account: 'owner.near' } });
    if (p === '/app/connect' && req.method() === 'GET') return route.fulfill({ json: { consents: [{ id: 'd'.repeat(64), scopes: ['read', 'treasury', 'treasury-execute'], expiresAt: Date.parse('2030-01-01T00:00:00Z'), revoked: false }] } });
    if (p === '/app/connect/prepare') { writes.push({ prepare: req.postDataJSON() }); return route.fulfill({ json: { message: CONSENT, recipient: PLATFORM, nonce: Buffer.alloc(32, 7).toString('base64'), scopes: ['read', 'treasury', 'treasury-orders'] } }); }
    if (p === '/app/connect' && req.method() === 'POST') { writes.push({ consent: req.postDataJSON() }); consented = true; return route.fulfill({ status: 201, json: { consent: {} } }); }
    if (p === '/app/tokens') return route.fulfill({ json: { tokens: [] } });
    if (p === '/app/proposals') return route.fulfill({ json: answer({ proposals: [] }) });
    if (p === '/app/orders/access') { reads.push('access'); if (options.accessFailure) return route.fulfill({ status: 503, json: { error: 'Order capability discovery is unavailable.' } }); return route.fulfill({ json: options.accessBody ?? { ...access, consented } }); }
    if (p === '/app/orders/consent') { writes.push({ daoConsent: req.postDataJSON() }); return route.fulfill({ json: { ...answer({ ...filed, request: { ...filed.request, scopes: ['read', 'treasury', 'treasury-orders'], expiresAt: Date.parse('2030-01-01T00:00:00Z'), description: 'Allow the Treasury app to propose individually approved orders.' } }), message: CONSENT } }); }
    if (p === `/app/orders/consent/${'f'.repeat(64)}`) { reads.push('daoConsentState'); consented = true; return route.fulfill({ json: answer({ state: 'signed', consent: {} }) }); }
    if (p === '/app/orders' && req.method() === 'GET') { reads.push('list'); return route.fulfill({ json: answer({ orders: options.empty ? [] : [view] }) }); }
    if (p === '/app/orders/quote') { writes.push({ quote: req.postDataJSON() }); return route.fulfill({ json: answer({ spendAsset: BASE, spendAmount: '1000000', outputAsset: QUOTE, warnings: options.warnings ?? [] }) }); }
    if (p === '/app/orders' && req.method() === 'POST') {
      writes.push({ create: req.postDataJSON() });
      if (createLost) { createLost = false; return route.abort(); }
      view = initialView(); return route.fulfill({ json: answer(view) });
    }
    if (p === `/app/orders/${ID}`) {
      reads.push('get');
      const step = orderReads.shift(); if (step?.beforeReply) await step.beforeReply();
      if (step?.abort) return route.abort();
      if (step?.answer) return route.fulfill({ json: step.answer });
      if (step?.view) view = { ...view, ...step.view };
      if (options.readDenied) return route.fulfill({ status: 403, json: { error: 'The order consent was revoked. Nothing was sent.', exit: 2 } });
      return route.fulfill({ json: { ...answer(view), attempts: options.attempts, sign: { recipient: PLATFORM, approve: APPROVE, reject: REJECT } } });
    }
    if (p === `/app/orders/${ID}/decide`) {
      const body = req.postDataJSON(); writes.push({ decide: body });
      const step = decisions.shift();
      if (step?.beforeReply) await step.beforeReply();
      if (step?.answer) {
        if (step.answer.result.ok) view = step.answer.result.value;
        return route.fulfill({ json: step.answer });
      }
      view.state = body.verdict === 'reject' ? 'rejected' : 'approved';
      return route.fulfill({ json: answer(view) });
    }
    if (p === `/app/orders/${ID}/place`) { writes.push('place'); if (options.losePlace) return route.abort(); view = { ...view, state: 'resting', orderId: 'provider-order-1', fillStatus: 'open', payoutStatus: 'not_started', isPayoutStatusFinal: false }; return route.fulfill({ json: answer(view) }); }
    if (p === `/app/orders/${ID}/cancel`) {
      writes.push('cancel');
      if (options.loseCancel) { if (options.lostCancelView) view = { ...view, ...options.lostCancelView }; return route.abort(); }
      view = { ...view, state: 'cancel_requested', cancelMayResume: options.cancelReplyMayResume ?? false }; return route.fulfill({ json: answer(view) });
    }
    if (p === `/app/orders/${ID}/cancel/continue`) {
      writes.push({ continueCancel: { id: ID, body: req.postDataJSON() } });
      if (options.beforeContinueReply) await options.beforeContinueReply();
      view = { ...view, state: 'cancel_requested', cancelMayResume: false, fillStatus: 'pending_cancel' };
      if (options.loseContinue) return route.abort();
      return route.fulfill({ json: answer(view) });
    }
    if (p === `/app/orders/${ID}/refresh`) {
      reads.push('refresh');
      const step = refreshes.shift(); if (step?.beforeReply) await step.beforeReply();
      if (step?.abort) return route.abort();
      if (step?.answer) return route.fulfill({ json: step.answer });
      if (step?.view) view = { ...view, ...step.view }; else if (options.refreshed) view = { ...view, ...options.refreshed };
      return route.fulfill({ json: answer(view) });
    }
    if (p === `/app/orders/${ID}/dao`) { writes.push({ daoFile: req.postDataJSON() }); return route.fulfill({ json: answer(filed) }); }
    if (p === `/app/orders/dao/${'f'.repeat(64)}`) { reads.push('daoState'); daoPolls++; if (daoPolls > 1) view.state = 'approved'; return route.fulfill({ json: answer({ state: daoPolls > 1 ? 'relayed' : 'pending', request: filed.request, orderState: view.state }) }); }
    if (p.startsWith('/app/')) throw Error(`Unexpected app route ${p}`);
    return route.fulfill({ path: p.startsWith('/static/') ? join(root, p) : join(root, 'proposals.html'), contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : p.startsWith('/static/') ? 'font/woff2' : 'text/html' });
  };
  await page.route('**/*', handleRoute);
  const url = 'http://localhost/?organization=org_1&agent=portfolio';
  await page.goto(url);
  const newTab = async () => { const next = await page.context().newPage(); next.setDefaultTimeout(8000); await next.route('**/*', handleRoute); await next.goto(url); return next; };
  return { page, writes, reads, errors, filed, newTab, setConsented: value => { consented = value; }, setView: next => { view = { ...view, ...next }; } };
}
const review = async page => { await page.getByRole('button', { name: `Review order ${ID.slice(0, 8)}`, exact: true }).click(); return page.getByRole('region', { name: 'Order review', exact: true }); };

async function orderConsentRenewal(browser, root) {
  const { page, writes, errors } = await open(browser, root, { consented: false });
  await page.getByRole('region', { name: 'Connection', exact: true }).getByText(/Connected: read, treasury, treasury-execute/).waitFor();
  const orders = page.getByRole('region', { name: 'Limit orders', exact: true });
  await orders.getByRole('button', { name: 'Review order consent', exact: true }).click();
  assert.deepEqual(writes.find(x => x.prepare).prepare, { organization: 'org_1', agent: 'portfolio', execute: false, days: 30, orders: true });
  assert.equal(await orders.getByRole('figure', { name: 'Order consent you sign' }).locator('pre').innerText(), CONSENT);
  await orders.getByRole('button', { name: 'Sign order consent', exact: true }).click();
  await orders.getByRole('button', { name: `Review order ${ID.slice(0, 8)}` }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.signed)).map(s => [s.message, s.recipient]), [[CONSENT, PLATFORM]]);
  assert.equal(writes.filter(x => x.consent).length, 1); assert.deepEqual(errors, []);
}
async function orderCapabilityGate(browser, root) {
  const { page, writes, reads } = await open(browser, root, { capable: false, consented: false });
  await page.getByText('This host does not offer limit orders.', { exact: true }).waitFor();
  assert(!reads.includes('list')); assert(!writes.length); assert.equal(await page.getByRole('button', { name: 'Review order consent' }).count(), 0);
}
async function orderExactSigningAndResting(browser, root) {
  const { page, writes, errors } = await open(browser, root);
  const order = await review(page);
  assert.equal(await order.getByRole('figure', { name: 'Exact order approval text' }).locator('pre').innerText(), APPROVE);
  await order.getByRole('button', { name: 'Sign exact order and approve', exact: true }).click();
  await order.getByRole('button', { name: 'Place approved order', exact: true }).waitFor();
  const signed = (await page.evaluate(() => window.signed))[0];
  assert.deepEqual([signed.message, signed.recipient], [APPROVE, PLATFORM]);
  assert.equal(writes.find(x => x.decide).decide.signed.message, APPROVE); assert(!writes.includes('place'));
  await order.getByRole('button', { name: 'Place approved order', exact: true }).click(); assert(!writes.includes('place'));
  await order.getByRole('button', { name: 'Confirm one placement attempt', exact: true }).click();
  await order.getByText('resting', { exact: true }).waitFor();
  assert.equal(writes.filter(x => x === 'place').length, 1);
  assert.equal(await order.getByText(/^Completed:/).count(), 0);
  await page.mouse.move(0, 0); await assertAccessible(page, 'limit order resting');
  if (process.env.PROTO_BROWSER_ARTIFACTS) { mkdirSync(process.env.PROTO_BROWSER_ARTIFACTS, { recursive: true }); await page.screenshot({ path: join(process.env.PROTO_BROWSER_ARTIFACTS, 'order-review-desktop.png'), fullPage: true }); }
  await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: join(process.env.PROTO_BROWSER_ARTIFACTS, 'order-review-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
}
async function orderLostPlaceReadOnly(browser, root) {
  const { page, writes, reads, errors } = await open(browser, root, { state: 'approved', losePlace: true });
  let order = await review(page);
  await order.getByRole('button', { name: 'Place approved order', exact: true }).click(); await order.getByRole('button', { name: 'Confirm one placement attempt', exact: true }).click();
  await order.getByText(/Placement was already attempted/).waitFor(); await order.getByRole('button', { name: 'Refresh fills and payout' }).waitFor({ state: 'visible' });
  await page.reload(); order = await review(page); await order.getByText(/Placement was already attempted/).waitFor();
  assert.equal(await order.getByRole('button', { name: 'Place approved order' }).count(), 0);
  await order.getByRole('button', { name: 'Refresh fills and payout' }).click();
  assert.equal(writes.filter(x => x === 'place').length, 1); assert(reads.filter(x => x === 'get').length >= 2); assert(reads.includes('refresh')); assert.deepEqual(errors, []);
}
async function orderLostCancelAndPartial(browser, root) {
  const { page, writes, reads, errors } = await open(browser, root, { state: 'partially_filled', loseCancel: true, view: { orderId: 'provider-order-1', fillStatus: 'partially_filled', payoutStatus: 'in_progress', isPayoutStatusFinal: false, partialFills: [{ amount: '400000' }], payouts: { output: { amount: '800000', status: 'in_progress' } } } });
  let order = await review(page); await order.getByText('partially_filled', { exact: true }).waitFor();
  await order.getByRole('button', { name: 'Request cancellation' }).click(); await order.getByRole('button', { name: 'Confirm one cancellation attempt' }).click();
  await order.getByRole('button', { name: 'Refresh fills and payout' }).click();
  await page.reload(); order = await review(page);
  assert.equal(await order.getByRole('button', { name: 'Request cancellation' }).count(), 0); assert.equal(writes.filter(x => x === 'cancel').length, 1); assert(reads.includes('refresh'));
  await order.getByText('Partial fill evidence (1)', { exact: true }).click(); await order.getByText(/400000/).waitFor();
  assert.equal(await order.getByText(/^Completed:/).count(), 0); assert.deepEqual(errors, []);
}
async function orderFinalPayoutEvidence(browser, root) {
  const { page } = await open(browser, root, { state: 'completed', view: { orderId: 'provider-order-1', fillStatus: 'filled', payoutStatus: 'in_progress', isPayoutStatusFinal: false }, refreshed: { state: 'completed', fillStatus: 'filled', payoutStatus: 'completed', isPayoutStatusFinal: true, payouts: { output: { status: 'completed', amount: '2125000' } } } });
  const order = await review(page); await order.getByText('unknown', { exact: true }).waitFor(); assert.equal(await order.getByText(/^Completed:/).count(), 0);
  await order.getByRole('button', { name: 'Refresh fills and payout' }).click(); await order.getByText('Completed: the provider reports a closed fill and final completed payouts.', { exact: true }).waitFor();
}
async function orderPayoutFailed(browser, root) {
  const { page } = await open(browser, root, { state: 'payout_failed', view: { fillStatus: 'filled', payoutStatus: 'failed', isPayoutStatusFinal: true } });
  const order = await review(page); await order.getByText('payout_failed', { exact: true }).waitFor(); await order.getByText(/Payout failed; review is required/).waitFor(); assert.equal(await order.getByText(/^Completed:/).count(), 0);
}
async function orderCreateLostExactRetry(browser, root) {
  const { page, writes, errors } = await open(browser, root, { empty: true, createLost: true });
  const orders = page.getByRole('region', { name: 'Limit orders', exact: true });
  await orders.getByLabel('Base asset', { exact: true }).fill(BASE); await orders.getByLabel('Quote asset', { exact: true }).fill(QUOTE);
  await orders.getByLabel('Quantity (atomic base units)', { exact: true }).fill('1000000'); await orders.getByLabel('Price (quote per base unit)', { exact: true }).fill('2.125');
  await orders.getByRole('button', { name: 'Preview exact spend' }).click(); await orders.getByRole('button', { name: 'Save and create order' }).click();
  await orders.getByRole('button', { name: 'Retry the same saved order request' }).waitFor();
  assert(await orders.getByLabel('Base asset', { exact: true }).isDisabled());
  await page.reload(); await orders.getByRole('button', { name: 'Retry the same saved order request' }).click();
  await page.getByRole('region', { name: 'Order review', exact: true }).waitFor();
  const bodies = writes.filter(x => x.create).map(x => x.create); assert.equal(bodies.length, 2); assert.deepEqual(bodies[1], bodies[0]); assert(bodies[0].requestId); assert.deepEqual(errors, []);
}
async function orderWrongWallet(browser, root) {
  const { page, writes } = await open(browser, root, { walletAccount: 'someone.near' });
  const order = await review(page); await order.getByRole('button', { name: 'Sign exact order and approve' }).click();
  await order.getByText(/switch it to owner.near.*Nothing was signed/).waitFor(); assert(!writes.some(x => x.decide)); assert.deepEqual(await page.evaluate(() => window.signed), []);
}
async function orderDaoVote(browser, root) {
  const { page, writes, reads, filed } = await open(browser, root, { dao: true });
  const order = await review(page); assert.equal(await order.getByRole('button', { name: 'Sign exact order and approve' }).count(), 0);
  await order.getByRole('button', { name: 'Prepare DAO approval vote' }).click();
  await order.getByRole('checkbox', { name: 'Also cast my approval vote' }).check(); await order.getByRole('button', { name: 'Submit DAO proposal and vote' }).click();
  await order.getByText(/Vote submitted/).waitFor();
  assert.deepEqual((await page.evaluate(() => window.transactions))[0], { signerId: 'owner.near', network: 'mainnet', ...filed.transactions.proposalAndVote });
  await order.getByRole('button', { name: 'Read DAO order vote' }).click(); await order.getByText('pending', { exact: true }).waitFor();
  await order.getByRole('button', { name: 'Read DAO order vote' }).click(); await order.getByRole('button', { name: 'Place approved order' }).waitFor();
  assert.equal(writes.filter(x => x.daoFile).length, 1); assert.equal(reads.filter(x => x === 'daoState').length, 2); assert(!writes.includes('place'));
}
async function orderDaoRoles(browser, root) {
  const { page, writes } = await open(browser, root, { dao: true, prepare: false, vote: false, execute: false });
  const order = await review(page); assert.equal(await order.getByRole('button', { name: 'Prepare DAO approval vote' }).count(), 0); assert.equal(await order.getByRole('button', { name: 'Submit DAO proposal' }).count(), 0); assert(!writes.length);
}
async function orderDaoConsentRenewal(browser, root) {
  const { page, writes, reads, filed, setConsented } = await open(browser, root, { dao: true, consented: false });
  const orders = page.getByRole('region', { name: 'Limit orders', exact: true });
  await orders.getByRole('button', { name: 'Prepare DAO order consent vote', exact: true }).click();
  assert.equal(await orders.getByRole('figure', { name: 'DAO order consent text' }).locator('pre').innerText(), CONSENT);
  await orders.getByRole('checkbox', { name: 'Also vote for this order consent' }).check();
  await orders.getByRole('button', { name: 'Submit DAO order consent and vote', exact: true }).click();
  await orders.getByText(/Consent vote submitted/).waitFor();
  assert.deepEqual((await page.evaluate(() => window.transactions))[0], { signerId: 'owner.near', network: 'mainnet', ...filed.transactions.proposalAndVote });
  await orders.getByRole('button', { name: 'Read DAO order consent', exact: true }).click();
  await orders.getByRole('button', { name: `Review order ${ID.slice(0, 8)}` }).waitFor();
  assert.equal(writes.filter(x => x.daoConsent).length, 1); assert.equal(reads.filter(x => x === 'daoConsentState').length, 1);
  setConsented(false); await page.reload(); await orders.getByRole('button', { name: 'Prepare DAO order consent vote', exact: true }).click();
  assert.equal(writes.filter(x => x.daoConsent).length, 2, 'a proven signed consent does not permanently lock renewal');
}
async function orderServerAttemptClaims(browser, root) {
  const { page, writes } = await open(browser, root, { state: 'approved', attempts: { place: true, cancel: true } });
  const order = await review(page); await order.getByText(/Placement was already attempted/).waitFor();
  assert.equal(await order.getByRole('button', { name: 'Place approved order' }).count(), 0);
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => key.endsWith(':place'))), []);
  assert(!writes.length);
}
async function orderAuthorityFailureIsReadable(browser, root) {
  const { page, errors } = await open(browser, root, { readDenied: true });
  const order = await review(page); await order.getByText('The order consent was revoked. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(await order.getByRole('button', { name: 'Sign exact order and approve' }).count(), 0); assert.deepEqual(errors, []);
}
async function orderCrossTabDraft(browser, root) {
  const { page, newTab, writes } = await open(browser, root, { empty: true, createLost: true });
  const second = await newTab();
  async function fill(target, price) {
    const orders = target.getByRole('region', { name: 'Limit orders', exact: true });
    await orders.getByLabel('Base asset', { exact: true }).fill(BASE); await orders.getByLabel('Quote asset', { exact: true }).fill(QUOTE);
    await orders.getByLabel('Quantity (atomic base units)', { exact: true }).fill('1000000'); await orders.getByLabel('Price (quote per base unit)', { exact: true }).fill(price);
    await orders.getByRole('button', { name: 'Preview exact spend' }).click(); await orders.getByRole('button', { name: 'Save and create order' }).waitFor();
    return orders;
  }
  const firstOrders = await fill(page, '2.125'); const secondOrders = await fill(second, '8.5');
  await firstOrders.getByRole('button', { name: 'Save and create order' }).click();
  await firstOrders.getByRole('button', { name: 'Retry the same saved order request' }).waitFor();
  await secondOrders.getByRole('button', { name: 'Retry the same saved order request' }).click();
  await second.getByRole('region', { name: 'Order review' }).waitFor();
  const bodies = writes.filter(x => x.create).map(x => x.create); assert.equal(bodies.length, 2); assert.deepEqual(bodies[1], bodies[0], 'a second mounted tab uses the original saved request and exact terms');
}

const refusedDecision = verdict => ({ exit: 2, result: { ok: false, kind: 'refused', code: 'signature_invalid', error: `The platform refused this ${verdict} decision.` } });
/** A definite refusal records no owner decision, for either exact verdict. */
function decisionRefusal(verdict) {
  const scenario = async (browser, root) => {
    const { page, writes, errors } = await open(browser, root, { decisions: [{ answer: refusedDecision(verdict) }] });
    const order = await review(page);
    await order.getByRole('button', { name: `Sign exact order and ${verdict}`, exact: true }).click();
    await order.getByText(`The platform refused this ${verdict} decision. (signature_invalid)`, { exact: true }).waitFor();
    assert.equal((await order.getByRole('status', { name: 'Order outcome', exact: true }).innerText()).includes('Decision recorded'), false,
      `a definite ${verdict} refusal must never claim a decision was recorded`);
    assert.equal(await order.getByRole('button', { name: 'Place approved order', exact: true }).count(), 0);
    assert.deepEqual(writes.filter(write => write.decide).map(write => write.decide.verdict), [verdict]);
    assert.deepEqual(errors, []);
  };
  Object.defineProperty(scenario, 'name', { value: `orderDecisionRefusal_${verdict}` });
  return scenario;
}
/** Hold the second HTTP reply so stale success text is checked before another outcome exists. */
async function orderDecisionClearsPreviousNotice(browser, root) {
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { reached = resolve; });
  const { page, setView, writes, errors } = await open(browser, root, { decisions: [
    { answer: answer(initialView('approved')) },
    { answer: refusedDecision('reject'), beforeReply: () => { reached(); return held; } },
  ] });
  const order = await review(page);
  await order.getByRole('button', { name: 'Sign exact order and approve', exact: true }).click();
  const outcome = order.getByRole('status', { name: 'Order outcome', exact: true });
  await outcome.getByText('Decision recorded. Approval alone places no order.', { exact: true }).waitFor();
  // The next platform read exposes a fresh proposed decision; the previous notice still exists until signing starts.
  setView({ state: 'proposed' });
  await order.getByRole('button', { name: 'Read this order', exact: true }).click();
  await order.getByRole('button', { name: 'Sign exact order and reject', exact: true }).click();
  await arrived;
  try {
    assert.equal(await outcome.innerText(), '', 'starting a new decision clears the previous success before its reply arrives');
  } finally { release(); }
  await order.getByText('The platform refused this reject decision. (signature_invalid)', { exact: true }).waitFor();
  assert.equal((await outcome.innerText()).includes('Decision recorded'), false);
  assert.equal(writes.filter(write => write.decide).length, 2);
  assert.deepEqual(errors, []);
}
/** An uncertain reply still says the decision may have been recorded and offers reads before another signature. */
async function orderDecisionAmbiguousNotice(browser, root) {
  const { page, writes, errors } = await open(browser, root, { decisions: [{ answer: {
    exit: 3, result: { ok: false, kind: 'unknown', error: 'The owner decision reply was lost.' },
  } }] });
  const order = await review(page);
  await order.getByRole('button', { name: 'Sign exact order and approve', exact: true }).click();
  const outcome = order.getByRole('status', { name: 'Order outcome', exact: true });
  await outcome.getByText('Your decision may have been recorded. Read the order before signing again.', { exact: true }).waitFor();
  assert.equal((await outcome.innerText()).includes('Decision recorded'), false);
  assert.equal(await order.getByRole('button', { name: 'Sign exact order and approve', exact: true }).count(), 0);
  assert.equal(writes.filter(write => write.decide).length, 1);
  assert.deepEqual(errors, []);
}

const pendingCancellation = { orderId: 'provider-order-1', cancelRequestedAt: '2026-11-11T12:00:00.000Z', fillStatus: 'partially_filled', payoutStatus: 'in_progress', isPayoutStatusFinal: false, partialFills: [{ amount: '400000' }], payouts: { output: { status: 'in_progress', amount: '800000' } } };
const continueButton = order => order.getByRole('button', { name: 'Continue pending cancellation', exact: true });
async function continuePending(order) {
  await continueButton(order).click();
  await order.getByRole('button', { name: 'Confirm pending cancellation continuation', exact: true }).click();
}
async function orderContinuePreparedCancellation(browser, root) {
  let release, reached;
  const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  const { page, writes, errors } = await open(browser, root, { state: 'cancel_requested', localCancelClaim: true,
    view: { ...pendingCancellation, cancelMayResume: true }, beforeContinueReply: () => { reached(); return held; },
    refreshed: { state: 'completed', fillStatus: 'canceled', payoutStatus: 'completed', isPayoutStatusFinal: true, cancelMayResume: false, payouts: { output: { status: 'completed', amount: '800000' } } } });
  const order = await review(page); await continueButton(order).waitFor();
  assert.equal(await order.getByRole('button', { name: 'Request cancellation', exact: true }).count(), 0, 'the existing claim never reopens initial cancellation');
  await continueButton(order).click(); assert(!writes.some(write => write.continueCancel), 'continuation requires explicit confirmation');
  await order.getByRole('button', { name: 'Confirm pending cancellation continuation', exact: true }).click(); await arrived;
  try { assert.equal(await continueButton(order).count(), 0, 'proof is cleared while the continuation is in flight'); } finally { release(); }
  await order.getByText('Pending cancellation continued for this order. Follow fills and final payout.', { exact: true }).waitFor();
  assert.deepEqual(writes.filter(write => write.continueCancel).map(write => write.continueCancel), [{ id: ID, body: { organization: 'org_1', agent: 'portfolio' } }]);
  assert(!writes.includes('cancel')); assert(!writes.includes('place')); assert(!writes.some(write => write.create));
  assert.equal(await continueButton(order).count(), 0); assert.equal(await order.getByText(/^Completed:/).count(), 0);
  await order.getByRole('button', { name: 'Refresh fills and payout', exact: true }).click();
  await order.getByText('Completed: the provider reports a closed fill and final completed payouts.', { exact: true }).waitFor();
  assert.equal(await continueButton(order).count(), 0); assert.deepEqual(errors, []);
}
async function orderLostInitialCancelPreparedContinuation(browser, root) {
  const { page, writes, reads, errors } = await open(browser, root, { state: 'partially_filled', view: { ...pendingCancellation, cancelRequestedAt: null, cancelMayResume: false }, loseCancel: true,
    lostCancelView: { state: 'cancel_requested', cancelRequestedAt: pendingCancellation.cancelRequestedAt, cancelMayResume: true } });
  const order = await review(page);
  await order.getByRole('button', { name: 'Request cancellation', exact: true }).click(); await order.getByRole('button', { name: 'Confirm one cancellation attempt', exact: true }).click();
  await continueButton(order).waitFor();
  assert(reads.filter(read => read === 'get').length >= 2); assert(reads.includes('refresh'), 'a lost initial answer is followed by fresh reads before offering continuation');
  await continuePending(order); await order.getByText('Pending cancellation continued for this order. Follow fills and final payout.', { exact: true }).waitFor();
  assert.equal(writes.filter(write => write === 'cancel').length, 1); assert.equal(writes.filter(write => write.continueCancel).length, 1);
  assert.equal(await order.getByRole('button', { name: 'Request cancellation', exact: true }).count(), 0); assert(!writes.includes('place')); assert(!writes.some(write => write.create)); assert.deepEqual(errors, []);
}
/** Missing, false and non-boolean evidence never permit a new initial cancel or a continuation. */
function cancellationResumeProof(value, label) {
  const scenario = async (browser, root) => {
    const view = { ...pendingCancellation, ...(label === 'missing' ? {} : { cancelMayResume: value }) };
    const { page, writes, errors } = await open(browser, root, { state: 'cancel_requested', view, attempts: { place: true, cancel: true } });
    const order = await review(page); await order.getByText('cancel_requested', { exact: true }).waitFor();
    assert.equal(await continueButton(order).count(), 0); assert.equal(await order.getByRole('button', { name: 'Request cancellation', exact: true }).count(), 0);
    await order.getByRole('button', { name: 'Refresh fills and payout', exact: true }).click();
    assert.equal(await continueButton(order).count(), 0); assert(!writes.length); assert.deepEqual(errors, []);
  };
  Object.defineProperty(scenario, 'name', { value: `orderCancellationResumeProof_${label}` }); return scenario;
}
async function orderLostContinuationPollOnly(browser, root) {
  const { page, writes, reads, errors } = await open(browser, root, { state: 'cancel_requested', view: { ...pendingCancellation, cancelMayResume: true }, attempts: { place: true, cancel: true }, loseContinue: true });
  let order = await review(page); await continuePending(order);
  await order.getByRole('button', { name: 'Refresh fills and payout', exact: true }).click();
  assert.equal(await continueButton(order).count(), 0, 'once submission may have begun, a lost reply remains poll-only');
  await page.reload(); order = await review(page); await order.getByText('cancel_requested', { exact: true }).waitFor();
  assert.equal(await continueButton(order).count(), 0); assert.equal(await order.getByRole('button', { name: 'Request cancellation', exact: true }).count(), 0);
  assert.equal(writes.filter(write => write.continueCancel).length, 1); assert(!writes.includes('cancel')); assert(!writes.includes('place')); assert(reads.includes('refresh')); assert.deepEqual(errors, []);
}
/** A new read immediately clears the old proof and a refusal cannot restore it. */
function cancellationReadFailure(mode) {
  const scenario = async (browser, root) => {
    let release, reached;
    const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
    const failure = { answer: { exit: 2, result: { ok: false, kind: 'unavailable', error: 'Fresh cancellation evidence is unavailable.' } }, beforeReply: () => { reached(); return held; } };
    const options = { state: 'cancel_requested', view: { ...pendingCancellation, cancelMayResume: true }, attempts: { place: true, cancel: true },
      ...(mode === 'get' ? { orderReads: [{}, failure] } : { refreshes: [failure] }) };
    const { page, writes, errors } = await open(browser, root, options);
    const order = await review(page); await continueButton(order).waitFor();
    await continueButton(order).click();
    await order.getByRole('button', { name: mode === 'get' ? 'Read this order' : 'Refresh fills and payout', exact: true }).click(); await arrived;
    try {
      assert.equal(await continueButton(order).count(), 0, 'old proof closes while the fresh read is pending');
      assert.equal(await order.getByRole('button', { name: 'Confirm pending cancellation continuation', exact: true }).count(), 0, 'an old confirmation is discarded');
    } finally { release(); }
    await order.getByText('Fresh cancellation evidence is unavailable.', { exact: true }).waitFor();
    assert.equal(await continueButton(order).count(), 0); assert.equal(await order.getByRole('button', { name: 'Request cancellation', exact: true }).count(), 0); assert(!writes.length); assert.deepEqual(errors, []);
  };
  Object.defineProperty(scenario, 'name', { value: `orderCancellationFailedFreshRead_${mode}` }); return scenario;
}
async function orderWrongIdContinuationProof(browser, root) {
  const { page, writes, errors } = await open(browser, root, { state: 'cancel_requested', localCancelClaim: true, view: { ...pendingCancellation, cancelMayResume: false },
    orderReads: [{ view: { id: '9'.repeat(32), cancelMayResume: true } }] });
  const order = await review(page); await order.getByText('The app did not return this exact order. Read status again; no cancellation can be continued.', { exact: true }).waitFor();
  assert.equal(await continueButton(order).count(), 0); assert(!writes.length); assert.deepEqual(errors, []);
}
async function orderActionReplyCannotGrantContinuation(browser, root) {
  const { page, writes } = await open(browser, root, { state: 'resting', view: { ...pendingCancellation, cancelRequestedAt: null, cancelMayResume: false }, cancelReplyMayResume: true });
  const order = await review(page); await order.getByRole('button', { name: 'Request cancellation', exact: true }).click(); await order.getByRole('button', { name: 'Confirm one cancellation attempt', exact: true }).click();
  await order.getByText('cancel_requested', { exact: true }).waitFor(); assert.equal(await continueButton(order).count(), 0, 'an action reply is not fresh read evidence');
  await order.getByRole('button', { name: 'Read this order', exact: true }).click(); await continueButton(order).waitFor();
  assert.equal(writes.filter(write => write === 'cancel').length, 1); assert(!writes.some(write => write.continueCancel));
}
function orderCapabilityReadClosed(mode) {
  const scenario = async (browser, root) => {
    const { page, writes, reads, errors } = await open(browser, root, { consented: false, ...(mode === 'failed' ? { accessFailure: true } : { accessBody: { capable: 'true', consented: false } }) });
    const orders = page.getByRole('region', { name: 'Limit orders', exact: true });
    await orders.getByText(mode === 'failed' ? 'Order capability discovery is unavailable.' : 'The Treasury app returned unreadable order access. Check access again.', { exact: true }).waitFor();
    assert.equal(await orders.getByRole('button', { name: 'Review order consent', exact: true }).count(), 0); assert.equal(await orders.getByRole('button', { name: 'Prepare DAO order consent vote', exact: true }).count(), 0);
    assert(!reads.includes('list')); assert(!writes.length); assert.deepEqual(errors, []);
  };
  Object.defineProperty(scenario, 'name', { value: `orderCapabilityReadClosed_${mode}` }); return scenario;
}
runTask([orderContinuePreparedCancellation, orderLostInitialCancelPreparedContinuation, cancellationResumeProof(undefined, 'missing'), cancellationResumeProof(false, 'attempted'), cancellationResumeProof('true', 'malformed'), orderLostContinuationPollOnly, cancellationReadFailure('get'), cancellationReadFailure('refresh'), orderWrongIdContinuationProof, orderActionReplyCannotGrantContinuation, orderCapabilityReadClosed('failed'), orderCapabilityReadClosed('malformed'), decisionRefusal('approve'), decisionRefusal('reject'), orderDecisionClearsPreviousNotice, orderDecisionAmbiguousNotice, orderServerAttemptClaims, orderAuthorityFailureIsReadable, orderCrossTabDraft, orderDaoConsentRenewal, orderConsentRenewal, orderCapabilityGate, orderExactSigningAndResting, orderLostPlaceReadOnly, orderLostCancelAndPartial, orderFinalPayoutEvidence, orderPayoutFailed, orderCreateLostExactRetry, orderWrongWallet, orderDaoVote, orderDaoRoles]);
