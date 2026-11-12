import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { environment } from './environment.mjs';
import { browserContext } from './wallet.mjs';
import { OWNER, PAYEE } from './provider.mjs';

async function rpc(page, agent, method, input) {
  return page.evaluate(async ({ agent, method, input }) => {
    const response = await fetch(`/a/${agent}/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) });
    return { status: response.status, body: await response.json() };
  }, { agent, method, input });
}
async function signedPage(browser, stack, account, path) {
  const wallet = await browserContext(browser, stack, account);
  await wallet.context.tracing.start({ screenshots: true, snapshots: true });
  const page = await wallet.context.newPage();
  await page.goto(`${stack.dashboard}${path}`);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/gw/me')).json()).viewer?.account)).toBe(account);
  return { ...wallet, page };
}
async function scenario(browser, info, run, options = {}) {
  const stack = await environment(info.outputPath('environment'), { workspace: true, ...options });
  stack.browserVersion = browser.version();
  const wallets = [];
  try { await run(stack, async (account, path) => { const wallet = await signedPage(browser, stack, account, path); wallets.push(wallet); return wallet; }); }
  finally {
    for (const [i, wallet] of wallets.entries()) {
      await wallet.page.screenshot({ path: info.outputPath(`${i}.png`), fullPage: true }).catch(() => {});
      writeFileSync(info.outputPath(`${i}.txt`), await wallet.page.locator('body').innerText().catch(() => 'unavailable'));
      await wallet.context.tracing.stop({ path: info.outputPath(`trace-${i}.zip`) });
      await wallet.context.close();
    }
    await stack.close();
    expect(stack.simulated.errors).toEqual([]); expect(stack.portfolio.errors).toEqual([]);
    for (const wallet of wallets) expect(wallet.unexpected).toEqual([]);
  }
}

test('cross-agent navigation keeps identity and gateway permissions isolated', async ({ browser }, info) => {
  await scenario(browser, info, async (stack, login) => {
    const { page } = await login(OWNER, '/a/payout/');
    await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
    const payout = await rpc(page, 'payout', 'instance');
    expect(payout.body.json.agentId).toBe(stack.simulated.id);
    await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: 'Agreements', exact: true }).click();
    await expect(page.getByRole('article', { name: `Recipient ${PAYEE}`, exact: true })).toBeVisible();
    const offer = page.getByText('Offer terms (a purchase order, a bounty or grant award)', { exact: true });
    await expect(offer).toBeVisible();
    expect(await offer.evaluate(element => element.parentElement.open)).toBe(false);
    await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: 'Payments', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
    // Cross-agent links must cause a document navigation, resetting client/cache ownership.
    await page.evaluate(() => { window.__candidateDocument = 'payout'; });
    const link = page.locator('a[href="/a/portfolio/"]').first();
    await link.click();
    await expect.poll(() => page.evaluate(() => window.__candidateDocument)).toBeUndefined();
    expect((await rpc(page, 'portfolio', 'instance')).body.json.agentId).toBe(stack.portfolio.id);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
    expect((await rpc(page, 'payout', 'instance')).body.json.agentId).toBe(stack.simulated.id);
    expect(stack.simulated.intents).toHaveLength(0);
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(stack.portfolioState().strategy).toBeNull();
  }, { portfolioOwner: OWNER });
});

test('each wallet sees only its own agents despite legacy operator configuration', async ({ browser }, info) => {
  await scenario(browser, info, async (stack, login) => {
    const owner = await login(OWNER, '/a/payout/');
    const ownerView = await owner.page.evaluate(async () => (await fetch('/gw/me')).json());
    expect(Object.keys(ownerView.viewer.access)).toEqual(['payout']);
    expect(ownerView.viewer.access.payout).toEqual({ canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true });
    expect((await rpc(owner.page, 'portfolio', 'instance')).status).toBe(403);
    expect((await rpc(owner.page, 'portfolio', 'autopilot/stop')).status).toBe(403);
    const restricted = await login(PAYEE, '/a/portfolio/automations');
    const me = await restricted.page.evaluate(async () => (await fetch('/gw/me')).json());
    expect(Object.keys(me.viewer.access)).toEqual(['portfolio']);
    expect(me.agents.map(a => a.name)).toEqual(['portfolio']);
    expect((await rpc(restricted.page, 'payout', 'instance')).status).toBe(403);
    expect((await rpc(restricted.page, 'payout', 'autopilot/stop')).status).toBe(403);
    await restricted.page.goto(`${stack.dashboard}/a/payout/`);
    await expect(restricted.page.getByRole('heading', { name: 'Payments', exact: true })).toHaveCount(0);
    expect(stack.simulated.intents).toHaveLength(0);
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(stack.portfolioState().strategy).toBeNull();
  });
});

test('strategy saves off, authorizes, rejects stale review, enables explicitly and stops during provider failure', async ({ browser }, info) => {
  await scenario(browser, info, async (stack, login) => {
    const { page, signatures } = await login(PAYEE, '/a/portfolio/automations');
    await expect(page.getByRole('heading', { name: 'Strategy', exact: true })).toBeVisible();
    const original = (await rpc(page, 'portfolio', 'strategy/get')).body.json;
    await page.getByRole('button', { name: 'Edit strategy', exact: true }).click();
    await page.getByLabel('USDC (%)', { exact: true }).fill('60');
    await page.getByLabel('wNEAR (%)', { exact: true }).fill('20');
    await page.getByLabel('ETH (%)', { exact: true }).fill('20');
    await page.getByLabel('Run every (minutes)', { exact: true }).fill('120');
    await page.getByRole('button', { name: 'Save with autopilot off', exact: true }).click();
    await expect.poll(() => stack.portfolioState().strategy?.autopilot.everyMin).toBe(120);
    expect(stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    expect(stack.portfolio.intents).toHaveLength(0);
    const saved = (await rpc(page, 'portfolio', 'strategy/get')).body.json;
    expect(saved.digest).not.toBe(original.digest);
    // An old tab cannot overwrite, authorize, or enable the newly saved strategy: each is refused for the stale review itself.
    const changed = 'The saved strategy changed. Compare it with your draft and review again.';
    for (const [method, input, message] of [
      ['strategy/save', { strategy: original.strategy, expectedDigest: original.digest }, changed],
      ['owner/prepare', { signer: 'wallet', action: { type: 'grant_issue', label: 'treasury', expectedStrategyDigest: original.digest } },
        'Review the current saved strategy before authorizing its grant; the strategy changed or was not reviewed.'],
      ['autopilot/enable', { expectedDigest: original.digest }, changed],
    ]) {
      const refused = await rpc(page, 'portfolio', method, input);
      expect({ method, status: refused.status, code: refused.body.json.code, message: refused.body.json.message }).toEqual({ method, status: 400, code: 'BAD_REQUEST', message });
    }
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(stack.portfolioState().strategy).toEqual(saved.strategy);
    await expect(page.getByRole('heading', { name: 'Authorize this saved strategy', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Authorize in wallet', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Turn on', exact: true })).toBeVisible();
    expect(stack.portfolio.intents).toHaveLength(1);
    expect(stack.portfolio.grants.at(-1).label).toBe(`treasury:${saved.digest.slice(7, 39)}`);
    expect(signatures.filter(s => s.recipient === 'local-provider')).toHaveLength(1);
    expect(stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    await page.getByRole('button', { name: 'Turn on', exact: true }).click();
    expect(stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    await page.getByRole('dialog').getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect.poll(() => stack.portfolioState().settings).toMatch(/AUTOPILOT=on\n/);
    stack.portfolio.setUnavailable(true);
    // Establish a real provider failure before using the provider-independent stop control.
    const unavailable = await rpc(page, 'portfolio', 'overview');
    expect({ status: unavailable.status, code: unavailable.body.json.code, provider: unavailable.body.json.data?.code }).toEqual({ status: 400, code: 'BAD_REQUEST', provider: 'http_error' });
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect.poll(() => stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    expect((await rpc(page, 'portfolio', 'autopilot/get')).body.json.on).toBe(false);
    await page.reload();
    expect((await rpc(page, 'portfolio', 'autopilot/get')).body.json.on).toBe(false);
    expect(stack.portfolio.transfers).toHaveLength(0);
    expect(stack.portfolio.requests.filter(r => r.method === 'POST' && r.path !== '/chain').map(r => r.path)).toEqual(['/v1/generate-intent', '/v1/submit-intent']);
  });
});
