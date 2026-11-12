const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { join, resolve } = require('node:path');
const { mkdirSync } = require('node:fs');
const { runTask } = require('./fixtures/task.cjs');
const { workspaceEvidence } = require('./fixtures/workspace.cjs');
const { rpcBody, rpcEvents } = require('./fixtures/rpc.cjs');
const { planEvent, savedEvent, actionEvent } = require('./fixtures/plans.cjs');
const { assertAccessible } = require('./fixtures/accessibility.cjs');

async function treasuryDemo(browser, root) {
  const { budget, setup, overview } = workspaceEvidence();
  for (const scenario of ['streamed', 'unknown', 'refused', 'blocked']) {
    const context = await browser.newContext({ viewport: { width: scenario === 'streamed' ? 1280 : 390, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const book = overview('treasury');
    book.area = 'treasury';
    book.book[0].priceUpdatedAt = new Date().toISOString();
    book.book[0].priceExpiresAt = new Date(Date.now() + 600_000).toISOString();
    const from = book.book[0], to = { asset: 'near', symbol: 'wNEAR', decimals: 24 };
    book.policy.policy.limits = { monthly: { usdc: '100000000' } };
    book.policy.policy.budget = { daily_usd: '100', weekly_usd: '100', monthly_usd: '100' };
    const planId = `00000000-0000-4000-8000-00000000000${['streamed', 'unknown', 'refused', 'blocked'].indexOf(scenario)}`, calls = [], writes = [], errors = [];
    const state = { started: false, results: 0, budgetError: false, recordsError: false, policyChanged: false, policyUnknown: false };
    const oldRefusal = { at: '2026-10-01T00:00:00Z', kind: 'swap', refused: 'spend_budget_exceeded', planId: 'older-plan', request: { origin_asset: 'usdc', destination_asset: 'near', amount: '1000000' } };
    const records = () => [oldRefusal, { at: '2026-10-15T12:00:00Z', kind: 'swap', status: 'SUCCESS', planId: 'unrelated-plan', correlationId: 'unrelated-operation', request: {} },
      ...(state.started ? scenario === 'refused' ? [{ ...oldRefusal, at: '2026-10-15T12:01:00Z', planId }] : [
        { at: '2026-10-15T12:01:00Z', kind: 'swap', planId, correlationId: 'selected-operation-one', status: scenario === 'unknown' ? undefined : 'SUCCESS', request: { origin_asset: 'usdc', destination_asset: 'near', amount: '1000000' } },
        ...(state.results === 2 ? [{ at: '2026-10-15T12:02:00Z', kind: 'swap', planId, correlationId: 'selected-operation-two', status: 'SUCCESS', request: { origin_asset: 'usdc', destination_asset: 'near', amount: '1000000' } }] : []),
      ] : []),
    ];
    let finishStream;
    const continuation = new Promise(resolve => { finishStream = resolve; });
    const server = createServer(async (request, response) => {
      if (request.url !== '/a/treasury/rpc/executePlan' || request.method !== 'POST') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
      state.started = true; state.results = 1;
      response.write(rpcEvents('executePlan', [actionEvent({ index: 0, status: 'SUCCESS', correlationId: 'selected-operation-one' })]));
      await continuation;
      state.results = 2;
      response.end(rpcEvents('executePlan', [actionEvent({ index: 1, status: 'SUCCESS', correlationId: 'selected-operation-two' })]));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const { hostname, pathname } = new URL(route.request().url());
        if (hostname !== '127.0.0.1') return route.abort();
        if (pathname === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'treasury', area: 'treasury', owner: 'owner.near', dao: false }], invoices: null,
          viewer: { account: 'owner.near', access: { treasury: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } } } });
        if (pathname.includes('/rpc/')) {
          const method = pathname.split('/rpc/')[1]; calls.push(method);
          if (method === 'rebalance') {
            writes.push(method);
            const legs = [0, 1].map(() => ({ from, to, amount: '1000000', usd: 1 }));
            const quotes = [0, 1].map(leg => ({ type: 'quote', leg, amountOut: '1000000000000000000000000', minAmountOut: '990000000000000000000000', costBps: 5, worstCostBps: 100, skipped: false }));
            const events = [planEvent({ legs, budget: '90' }), ...quotes, savedEvent({ id: planId, expiresAt: '2030-01-01T00:00:00Z', legs, quotes, steps: [0, 1] })];
            return route.fulfill({ contentType: 'text/event-stream', body: rpcEvents(method, events) });
          }
          if (method === 'executePlan') {
            writes.push(method); assert.deepEqual(route.request().postDataJSON().json, { planId });
            if (scenario === 'streamed') return route.continue();
            // The platform refuses before sending: an earlier operation has no proven outcome (typed CONFLICT, as the server answers).
            if (scenario === 'blocked') { state.refused = true; return route.fulfill({ status: 409, json: { json: { defined: false, code: 'CONFLICT',
              message: '1 earlier money action(s) have no proven outcome: earlier-operation. Run `pnpm reconcile` before sending new ones.', data: { kind: 'unresolved' } } } }); }
            state.started = true;
            return route.fulfill({ status: 500, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: scenario === 'unknown' ? 'Execution response interrupted' : 'spend_budget_exceeded' } } });
          }
          if ((method === 'overview' && state.budgetError) || (method === 'activity' && state.recordsError)) return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Observation unavailable' } } });
          const current = structuredClone(book);
          if (state.policyChanged) current.digest = 'new-policy';
          if (state.policyUnknown) current.digest = null;
          current.policy.usage.budget = Object.fromEntries(Object.entries(budget).map(([period, window]) => [period, { ...window, remaining_usd: String(90 - state.results), spent_usd: String(10 + state.results) }]));
          const values = { setup: { ...setup, executor: true }, instance: { agentId: 'fixture', executor: true }, overview: current, 'treasury/get': null,
            unresolved: state.started && scenario === 'unknown' ? [{ key: 'unknown-operation', kind: 'swap', sent: true, at: new Date().toISOString(), request: {}, status: null }]
              : scenario === 'blocked' && state.refused ? [{ key: 'earlier-operation', kind: 'swap', sent: true, at: '2026-10-15T11:00:00Z', request: {}, status: null }] : [],
            activity: records(), 'owner/actions': [], 'autopilot/get': { on: false, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null } };
          return route.fulfill({ json: rpcBody(values, method) });
        }
        if (pathname.startsWith('/static/')) return route.fulfill({ path: join(root, pathname), contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: join(root, 'index.html'), contentType: 'text/html' });
      });
      await page.goto(origin + '/a/treasury/');
      await page.getByRole('table', { name: 'USD budget windows' }).waitFor({ timeout: 2000 });
      assert.equal(calls.includes('activity'), false, 'history loads on request, not on entry');
      await page.getByText('Review recorded refusals', { exact: true }).click();
      await page.getByText('spend_budget_exceeded', { exact: true }).waitFor();
      assert.deepEqual(writes, [], 'reviewing refusals issues no probe');
      await page.getByText('Review recorded refusals', { exact: true }).click();
      const rebalance = page.getByRole('region', { name: 'Quoted rebalance', exact: true });
      await rebalance.getByRole('button', { name: 'Preview', exact: true }).click();
      await rebalance.getByRole('button', { name: 'Execute', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Execute the previewed rebalance on mainnet?' });
      assert.deepEqual(writes, ['rebalance'], 'opening confirmation does not execute');
      const summary = dialog.getByRole('region', { name: 'Saved plan summary', exact: true });
      assert.equal(await summary.getByText('1 USDC → wNEAR', { exact: true }).count(), 2, 'confirmation repeats each saved swap');
      assert.equal(await summary.getByText('Minimum received 0.99 wNEAR', { exact: true }).count(), 2, 'confirmation includes the quoted floors');
      assert.equal(await summary.locator('time').getAttribute('datetime'), '2030-01-01T00:00:00Z');
      await assertAccessible(page, `confirmation-${scenario}`);
      if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: join(process.env.PROTO_BROWSER_ARTIFACTS, `confirmation-${scenario}.png`) });
      await page.keyboard.press('Escape');
      assert.deepEqual(writes, ['rebalance'], 'cancelling the detailed review never executes');
      assert.equal(await rebalance.getByRole('button', { name: 'Execute', exact: true }).evaluate(e => e === document.activeElement), true, 'cancel restores focus');
      await rebalance.getByRole('button', { name: 'Execute', exact: true }).click();
      await dialog.getByRole('button', { name: 'Execute swaps', exact: true }).click();
      if (scenario === 'blocked') {
        // A race: the unresolved read was clear, the platform refuses before sending. Guidance follows the typed kind, not the server's operator wording.
        const hint = rebalance.getByRole('status').filter({ hasText: 'Unresolved operations block new sends.' });
        await hint.waitFor();
        await hint.getByText('Nothing was sent. Follow their outcomes before another action.', { exact: false }).waitFor();
        assert.equal(await hint.getByRole('link', { name: 'Review unresolved operations', exact: true }).getAttribute('href'), '/a/treasury/activity');
        assert.equal(await page.getByText(/outcome is unknown/i).count(), 0, 'a refusal before sending is not an unknown outcome');
        assert.equal(await page.getByText('Run `pnpm reconcile`', { exact: false }).count(), 0, 'operator CLI guidance is not shown to the owner');
        // A definite refusal follows no plan, so "Nothing was sent" never meets "does not establish that nothing was sent".
        assert.equal(await page.getByRole('region', { name: 'Confirmed plan outcome', exact: true }).count(), 0, 'a refused plan is not followed');
        assert.equal(await page.getByText(/does not establish that nothing was sent/).count(), 0);
        assert.equal(new URL(page.url()).searchParams.get('plan'), null, 'a refused plan is not kept in the page address');
        assert.equal(state.started, false);
        // The refreshed read now reports the operation: Execute is withdrawn with the reason.
        await rebalance.getByText('New sends are blocked by 1 unresolved operation. Preview is still available.', { exact: true }).waitFor();
        assert.equal(await rebalance.getByRole('button', { name: 'Execute', exact: true }).isDisabled(), true);
        assert.deepEqual(writes, ['rebalance', 'executePlan'], 'a refusal is never retried');
        assert.deepEqual(errors, []);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: join(process.env.PROTO_BROWSER_ARTIFACTS, 'refused-race.png'), fullPage: true });
        continue;
      }
      const outcome = page.getByRole('region', { name: 'Confirmed plan outcome', exact: true });
      await outcome.waitFor();
      await outcome.getByText('Confirmed plan reference', { exact: true }).click();
      await outcome.getByText(planId, { exact: true }).waitFor();
      const operations = outcome.getByRole('heading', { name: 'This plan’s operations', exact: true });
      await operations.waitFor();
      // When this plan's operations were last read is shown beside them; a read time is not settlement.
      await outcome.getByText(/^Operations last read: /).waitFor();
      assert.equal(await outcome.getByText(/^Operations last read: not yet/).count(), 0, 'a completed records read reports its time');
      assert.equal(await outcome.getByText('unrelated-operation', { exact: true }).count(), 0, 'never substitutes another plan');
      if (scenario === 'streamed') {
        await outcome.getByText('$89.00', { exact: true }).first().waitFor();
        assert.equal(state.results, 1, 'budget refresh occurs while execution stream remains open');
        finishStream();
        await outcome.getByText('$88.00', { exact: true }).first().waitFor();
        state.policyChanged = true;
        await outcome.getByRole('button', { name: 'Refresh observations', exact: true }).click();
        await outcome.getByText('The reported policy changed.', { exact: false }).waitFor();
        assert.equal(await outcome.getByText('$88.00', { exact: true }).count(), 0, 'do not compare headroom across policies');
        state.policyChanged = false;
        state.policyUnknown = true;
        await outcome.getByRole('button', { name: 'Refresh observations', exact: true }).click();
        await outcome.getByText('Policy identity is unavailable.', { exact: false }).waitFor();
        assert.equal(await outcome.getByText('$88.00', { exact: true }).count(), 0, 'missing policy identity cannot establish a comparison');
        state.policyUnknown = false;
        await outcome.getByRole('button', { name: 'Refresh observations', exact: true }).click();
        await outcome.getByText('$88.00', { exact: true }).first().waitFor();
        assert.equal(await outcome.getByText('$90.00', { exact: true }).count(), 3, 'baseline remains the pre-confirmation observations');
        state.budgetError = true; state.recordsError = true;
        await outcome.getByRole('button', { name: 'Refresh observations', exact: true }).click();
        await outcome.getByText('Current budget observation unavailable.', { exact: true }).waitFor();
        assert.equal(await outcome.getByText('$88.00', { exact: true }).count(), 0, 'failed refresh cannot masquerade as a current budget');
        assert.equal(await outcome.getByText('No operations for this plan are recorded here yet.', { exact: false }).count(), 0, 'failed records read is not empty history');
        state.budgetError = false; state.recordsError = false;
        await outcome.getByRole('button', { name: 'Refresh observations', exact: true }).click();
        await outcome.getByText('$88.00', { exact: true }).first().waitFor();
      } else if (scenario === 'unknown') {
        await page.getByRole('heading', { name: 'Unresolved operations', exact: true }).waitFor();
        assert.equal(await outcome.getByText(/completed|settled successfully/i).count(), 0, 'stream error never establishes settlement');
      } else await outcome.getByText('refused · over the USD budget', { exact: true }).waitFor();
      assert.deepEqual(writes, ['rebalance', 'executePlan'], 'refresh and outcomes never replay a send');
      assert.deepEqual(errors, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (scenario === 'streamed') {
        const shots = resolve(process.env.PROTO_BROWSER_ARTIFACTS || '.test-artifacts/treasury-demo'); mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, 'outcome-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: join(shots, 'outcome-mobile.png'), fullPage: true });
      }
      assert.equal(new URL(page.url()).searchParams.get('plan'), planId, 'confirmation records the exact plan in the page address');
      await page.reload();
      await page.getByRole('heading', { name: 'Rebalance', exact: true }).waitFor();
      const reopened = page.getByRole('region', { name: 'Confirmed plan outcome', exact: true });
      await reopened.getByText('Following the exact plan named in this page’s address.', { exact: false }).waitFor();
      await reopened.getByRole('heading', { name: 'This plan’s operations', exact: true }).waitFor();
      await reopened.getByText('Before confirmation: not retained after reload.', { exact: false }).waitFor();
      assert.equal(await reopened.getByText('Policy identity is unavailable.', { exact: false }).count(), 0, 'a reopened plan is not described as an unknown policy');
      assert.equal(await reopened.getByText('unrelated-operation', { exact: true }).count(), 0, 'reload never substitutes another plan');
      if (scenario === 'streamed') {
        await reopened.locator('#operation-selected-operation-two').waitFor({ state: 'attached' });
        assert.equal(await reopened.locator('[id^="operation-"]').count(), 2, 'reload follows both of the exact plan\u2019s operations');
        await reopened.getByText('$88.00', { exact: true }).first().waitFor();
        assert.equal(await reopened.getByText('$90.00', { exact: true }).count(), 0, 'no pre-confirmation baseline is invented after reload');
      } else if (scenario === 'unknown') {
        await page.getByRole('heading', { name: 'Unresolved operations', exact: true }).waitFor();
        assert.equal(await reopened.getByText(/completed|settled successfully/i).count(), 0, 'reload never establishes settlement');
      } else await reopened.getByText('refused · over the USD budget', { exact: true }).waitFor();
      await assertAccessible(page, `reopened-${scenario}`);
      assert.deepEqual(writes, ['rebalance', 'executePlan'], 'reload follows records and never replays a send');
      await reopened.getByRole('button', { name: 'Stop following this plan', exact: true }).click();
      await page.getByRole('region', { name: 'Confirmed plan outcome', exact: true }).waitFor({ state: 'detached' });
      assert.equal(new URL(page.url()).searchParams.get('plan'), null, 'stopping removes the plan from the page address');
      await page.reload();
      await page.getByRole('heading', { name: 'Rebalance', exact: true }).waitFor();
      assert.equal(await page.getByRole('region', { name: 'Confirmed plan outcome', exact: true }).count(), 0, 'a stopped plan stays unselected after reload');
      assert.deepEqual(writes, ['rebalance', 'executePlan'], 'stopping follows nothing new and sends nothing');
      if (scenario === 'refused') {
        await page.goto(origin + '/a/treasury/?plan=..%2Fselected');
        await page.getByRole('heading', { name: 'Rebalance', exact: true }).waitFor();
        assert.equal(await page.getByRole('region', { name: 'Confirmed plan outcome', exact: true }).count(), 0, 'a malformed plan reference selects nothing');
        assert.deepEqual(writes, ['rebalance', 'executePlan']);
      }
    } catch (error) {
      console.error('Treasury fixture failure:', { scenario, state, calls, writes }, await page.locator('body').innerText());
      throw error;
    } finally {
      finishStream(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await context.close();
    }
  }
}
/**
 * Execute and Shield follow the current unresolved read: a successful read that reports a blocking operation disables
 * them with the reason, Preview keeps working, and a failed read leaves both as before. The server's refusal stays the authority.
 */
async function sendBlock(browser, root) {
  const { setup, overview } = workspaceEvidence();
  const REASON = 'New sends are blocked by 1 unresolved operation. Preview is still available.';
  for (const read of ['blocked', 'clear', 'failed']) for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const book = overview('treasury');
    book.area = 'treasury';
    book.book[0].priceUpdatedAt = new Date().toISOString();
    book.book[0].priceExpiresAt = new Date(Date.now() + 600_000).toISOString();
    const from = book.book[0], to = { asset: 'near', symbol: 'wNEAR', decimals: 24 };
    const writes = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.route('**/*', async route => {
        const { hostname, pathname } = new URL(route.request().url());
        if (hostname !== 'frontend.test') return route.abort();
        if (pathname === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'treasury', area: 'treasury', owner: 'owner.near', dao: false }], invoices: null,
          viewer: { account: 'owner.near', access: { treasury: { canSign: true, canPropose: true, canVote: true, canExecute: true, canManage: true } } } } });
        if (pathname.includes('/rpc/')) {
          const method = pathname.split('/rpc/')[1];
          if (method === 'rebalance') {
            writes.push(method);
            const legs = [{ from, to, amount: '1000000', usd: 1 }];
            const quotes = [{ type: 'quote', leg: 0, amountOut: '1000000000000000000000000', minAmountOut: '990000000000000000000000', costBps: 5, worstCostBps: 100, skipped: false }];
            return route.fulfill({ contentType: 'text/event-stream', body: rpcEvents(method, [planEvent({ legs, budget: '90' }), ...quotes,
              savedEvent({ id: '00000000-0000-4000-8000-000000000009', expiresAt: '2030-01-01T00:00:00Z', legs, quotes, steps: [0] })]) });
          }
          if (method === 'sweep') {
            writes.push(`${method}:${route.request().postDataJSON().json.execute}`);
            return route.fulfill({ contentType: 'text/event-stream', body: rpcEvents(method, [{ type: 'plan', exposed: [{ ...from, public: 5000000n, confidential: 0n }] }]) });
          }
          if (method === 'unresolved' && read === 'failed') return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Fixture read unavailable' } } });
          return route.fulfill({ json: rpcBody({ setup: { ...setup, executor: true, grant: { ...setup.grant, label: 'treasury' } }, instance: { agentId: 'fixture', executor: true }, overview: book, 'treasury/get': null,
            unresolved: read === 'blocked' ? [{ key: 'preserved-operation', kind: 'swap', sent: false, at: new Date().toISOString(), request: {}, status: null }] : [],
            activity: [], 'owner/actions': [], 'autopilot/get': { on: false, everyMin: 60, maxUsd: 10, lastRun: null, nextRun: null } }, method) });
        }
        if (pathname.startsWith('/static/')) return route.fulfill({ path: join(root, pathname), contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/woff2' });
        return route.fulfill({ path: join(root, 'index.html'), contentType: 'text/html' });
      });
      await page.goto('http://frontend.test/a/treasury/');
      const rebalance = page.getByRole('region', { name: 'Quoted rebalance', exact: true });
      const sweep = page.getByRole('region', { name: 'Confidential sweep', exact: true });
      if (read === 'failed') await page.getByText('Unresolved operations could not be loaded.', { exact: false }).waitFor({ timeout: 15000 });
      else if (read === 'blocked') await rebalance.getByText(REASON, { exact: true }).waitFor();
      else await page.getByRole('heading', { name: 'Rebalance', exact: true }).waitFor();
      await rebalance.getByRole('button', { name: 'Preview', exact: true }).click();
      await rebalance.getByText(/Valid until/).waitFor();
      await sweep.getByRole('button', { name: 'Preview', exact: true }).click();
      await sweep.getByText(/public$/).first().waitFor();
      const executeDisabled = await rebalance.getByRole('button', { name: 'Execute', exact: true }).isDisabled();
      const shieldDisabled = await sweep.getByRole('button', { name: 'Shield', exact: true }).isDisabled();
      assert.equal(executeDisabled, read === 'blocked', `${read}-${width}: Execute ${read === 'blocked' ? 'disabled' : 'enabled'}`);
      assert.equal(shieldDisabled, read === 'blocked', `${read}-${width}: Shield ${read === 'blocked' ? 'disabled' : 'enabled'}`);
      assert.equal(await rebalance.getByText(REASON, { exact: true }).count(), read === 'blocked' ? 1 : 0, `${read}-${width}: rebalance reason`);
      assert.equal(await sweep.getByText(REASON, { exact: true }).count(), read === 'blocked' ? 1 : 0, `${read}-${width}: sweep reason`);
      assert.deepEqual(writes, ['rebalance', 'sweep:false'], 'Preview keeps working and nothing is sent');
      assert.deepEqual(errors, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${read}-${width}: horizontal overflow`);
      if (process.env.PROTO_BROWSER_ARTIFACTS) await page.screenshot({ path: join(process.env.PROTO_BROWSER_ARTIFACTS, `send-block-${read}-${width}.png`), fullPage: true });
    } finally { await context.close(); }
  }
}
runTask([treasuryDemo, sendBlock]);
