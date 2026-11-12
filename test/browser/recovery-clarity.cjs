/** Status checks preserve uncertain outcomes and never prepare or repeat a money action. */
const assert = require('node:assert/strict');
const { runSuite } = require('./fixtures/task.cjs');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const { rpcAnswer, rpcBody } = require('./fixtures/rpc.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');

runSuite(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  const results = [];
  try {
    for (const width of [390, 1280]) for (const scenario of ['outcomes', 'owner-records']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(5000);
      await page.clock.install();
      const calls = [], errors = [];
      const state = { checked: false, empty: false, ownerError: false, ownerDenied: false };
      const at = new Date().toISOString();
      const checks = [
        { key: 'successful-operation', outcome: 'settled', status: 'SUCCESS', detail: null },
        { key: 'failed-operation', outcome: 'settled', status: 'FAILED', detail: null },
        { key: 'held-operation', outcome: 'open', status: 'PENDING_APPROVAL', detail: null },
        { key: 'unread-held-operation', outcome: 'unknown', status: 'PENDING_APPROVAL', detail: 'status unread: Provider unavailable' },
        { key: 'unknown-operation', outcome: 'unknown', status: null, detail: 'No operation id; acceptance is unknown.' },
      ];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const { hostname, pathname: p } = new URL(route.request().url());
        if (hostname !== 'frontend.test') return route.abort();
        if (p === '/gw/me') return route.fulfill({ json: { invoices: null,
          agents: [{ name: 'treasury', area: 'treasury', owner: 'owner.near', dao: false }],
          viewer: { account: 'owner.near', access: { treasury: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } },
        } });
        if (p.includes('/rpc/')) {
          const method = p.split('/rpc/')[1]; calls.push(method);
          if (method === 'owner/actions' && (state.ownerError || state.ownerDenied)) return route.fulfill({
            status: state.ownerDenied ? 403 : 503,
            json: { json: { defined: false, code: state.ownerDenied ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR', message: 'Owner records unavailable' } },
          });
          if (method === 'recover') {
            state.checked = true;
            return route.fulfill({ json: rpcAnswer(method, state.empty ? [] : checks) });
          }
          const values = {
            instance: { agentId: 'fixture', executor: true },
            setup: { agentId: 'fixture', executor: true, wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near', public_key: 'ed25519:fixture' }, grant: null, dao: null },
            overview: { agentId: 'fixture', area: 'treasury', book: [], unmanaged: [], target: {}, rebalance: { minLegUsd: 1, maxCostBps: 100 }, grants: [], agreed: [], notInForce: null, policy: { policy: { actions: ['swap'], destinations: { mode: 'only', list: [] }, frozen: false, confidential: false, owner_approval: false, assets: 'any', limits: {}, max_actions_per_hour: 10, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0 }, wallet_id: 'agent.near', revision: null, status: 'APPLIED', provider_policy_synced: true, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, usage: { budget: { daily: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, weekly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null }, monthly: { limit_usd: null, spent_usd: '0', remaining_usd: null, resets_at: null } }, timelock: { delay_ms: 0, scheduled_count: 0 } } }, digest: null },
            'treasury/get': null, 'autopilot/get': { on: false, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null },
            activity: [], held: [], 'owner/pending': [], 'inbox/list': [], 'agreements/list': [], invoices: [], reconcileBooks: [],
            'owner/actions': [{ correlationId: 'retained-owner', type: 'approval_vote', signer: 'wallet', stage: 'submitted', expiresAt: at, ownerSucceeded: false, status: null, payment: { correlationId: 'retained-payment', verdict: 'approve' }, failureCode: null }],
            unresolved: scenario !== 'outcomes' || state.empty ? [] : (state.checked ? checks.slice(-1) : checks).map(check => ({ key: check.key, kind: 'payout', at, request: {}, status: check.status, sent: Boolean(check.status) })),
            paymentHistory: { items: [], complete: true }, 'strategy/get': null, 'autopilot/evidence': { ticks: [], corrupt: [] },
          };
          return route.fulfill({ json: rpcBody(values, method) });
        }
        if (p.startsWith('/static/')) return route.fulfill({ path: root + p, contentType: p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' });
      });
      try {
        await page.goto('http://frontend.test/a/treasury/activity');
        await page.locator('#owner-retained-owner').waitFor();
        assert.ok(!calls.includes('recover'), 'opening Activity does not request reconciliation');
        if (scenario === 'outcomes') {
          await page.getByRole('button', { name: 'Check operation outcomes', exact: true }).click();
          const list = page.getByRole('list', { name: 'Operation status results' });
          await list.waitFor();
          assert.equal(await list.locator('li').count(), 5);
          const failed = list.locator('li').filter({ hasText: 'failed-operation' });
          assert.match(await failed.innerText(), /failed/i);
          assert.doesNotMatch(await failed.innerText(), /paid|successful|safe to retry/i);
          assert.match(await failed.innerText(), /replacement operation/i, 'a Treasury agent names a replacement operation, not a payment');
          assert.match(await list.locator('li').filter({ has: page.getByText('held-operation', { exact: true }) }).innerText(), /owner approval/i);
          assert.match(await list.locator('li').filter({ hasText: 'unknown-operation' }).innerText(), /outcome.*unknown/i);
          const unread = list.locator('li').filter({ hasText: 'unread-held-operation' });
          assert.match(await unread.innerText(), /Outcome still unknown/);
          assert.match(await unread.innerText(), /Last recorded: pending_approval/);
          await page.getByText('Outcome details', { exact: true }).last().click();
          await page.getByText('No operation id; acceptance is unknown.', { exact: true }).waitFor();
          if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: path.join(process.env.PROTO_BROWSER_ARTIFACTS, `outcomes-${width}.png`), fullPage: true });
          await page.reload();
          await page.getByRole('button', { name: 'Check operation outcomes', exact: true }).waitFor();
          assert.equal(calls.filter(method => method === 'recover').length, 1, 'reload does not repeat the check or a submission');
          state.empty = true;
          await page.getByRole('button', { name: 'Check operation outcomes', exact: true }).click();
          await page.getByText(/No open operations were returned by this check/).waitFor();
        } else {
          const ownerSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Owner actions', exact: true }) });
          state.ownerError = true;
          await page.clock.fastForward(6000); await page.clock.runFor(100);
          await page.getByText(/Owner actions could not be refreshed/).waitFor();
          const retained = page.locator('#owner-retained-owner');
          await retained.waitFor();
          await retained.getByText('Owner action reference', { exact: true }).click();
          await page.getByText('retained-owner', { exact: true }).waitFor();
          state.ownerError = false;
          await ownerSection.getByRole('button', { name: 'Check again', exact: true }).click();
          const refresh = ownerSection.getByRole('button', { name: 'Refresh owner actions', exact: true });
          await refresh.waitFor();
          assert.ok(await refresh.evaluate(element => element === document.activeElement), 'retry restores focus to the replacement refresh control');
          assert.ok(await page.getByText('retained-owner', { exact: true }).isVisible(), 'refresh preserves open record details');
          state.ownerError = true;
          await refresh.click();
          const retry = ownerSection.getByRole('button', { name: 'Check again', exact: true });
          await retry.waitFor();
          assert.ok(await retry.evaluate(element => element === document.activeElement), 'failed explicit refresh keeps focus on its replacement retry control');
          if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: path.join(process.env.PROTO_BROWSER_ARTIFACTS, `retained-owner-${width}.png`), fullPage: true });
          state.ownerError = false;
          await retry.click();
          await refresh.waitFor();
          state.ownerDenied = true;
          await refresh.click();
          await retained.waitFor({ state: 'hidden' });
          assert.doesNotMatch(await page.locator('body').textContent(), /retained-owner|retained-payment/);
          assert.ok(!calls.includes('recover'));
        }
        assert.ok(!calls.some(method => /^(pay|executePlan|owner\/prepare|owner\/submit|autopilot\/tick)$/.test(method)), 'status controls never prepare, sign or send');
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        results.push({ width, scenario, pass: true });
      } catch (error) { results.push({ width, scenario, pass: false, error: error.message }); }
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.every(result => result.pass) ? 0 : 1;
});
