import { readFileSync } from 'node:fs';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

const [command, argument, ...extra] = process.argv.slice(2);
const usage = 'Usage: treasury.mjs inspect|strategy|activity|unresolved|prepare FILE|execute PLAN_ID|sweep-preview|sweep';
const commands = new Set(['inspect', 'strategy', 'activity', 'unresolved', 'prepare', 'execute', 'sweep-preview', 'sweep']);
const moving = command === 'execute' || command === 'sweep';
try {
  if (!commands.has(command) || extra.length || (['prepare', 'execute'].includes(command) ? !argument : argument)) throw new Error(usage);
  const origin = new URL(process.env.TREASURY_URL ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('TREASURY_URL must be an HTTPS origin without credentials, path, query or fragment');
  const name = process.env.TREASURY_NAME;
  const token = process.env.TREASURY_MACHINE_TOKEN;
  if (!/^[a-z0-9-]{1,32}$/.test(name ?? '') || !/^tmc_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token ?? ''))
    throw new Error('Configure TREASURY_NAME and TREASURY_MACHINE_TOKEN in the runtime environment');
  const client = createORPCClient(new RPCLink({ origin: origin.origin, url: `/machine/v1/a/${name}/rpc`,
    headers: { authorization: `Bearer ${token}` },
    fetch: async (url, options) => {
      const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(180_000) });
      if (command === 'prepare' && [404, 405].includes(response.status))
        throw Object.assign(new Error('Chosen-swap support unavailable'), { code: 'NOT_FOUND' });
      return response;
    },
  }));
  let answer;
  if (command === 'inspect') answer = await client.overview();
  if (command === 'strategy') answer = await client.strategy.get();
  if (command === 'activity') answer = await client.activity();
  if (command === 'unresolved') answer = await client.unresolved();
  if (command === 'prepare') {
    const input = JSON.parse(readFileSync(argument, 'utf8'));
    answer = await client.externalPlan(input);
    // An ambiguous or incompatible response is not a reviewed plan. Never substitute rebalance.
    if (answer?.source !== 'external' || !/^[0-9a-f-]{36}$/.test(answer.id ?? '') ||
        !Array.isArray(answer.actions) || answer.actions.length !== input.swaps.length ||
        answer.actions.some((action, i) => action.type !== 'swap' ||
          ['from', 'to', 'amount'].some(key => action[key] !== input.swaps[i][key]) ||
          !/^[0-9]{1,40}$/.test(action.minAmountOut ?? '') || BigInt(action.minAmountOut) <= 0n ||
          (input.swaps[i].minAmountOut && BigInt(action.minAmountOut) < BigInt(input.swaps[i].minAmountOut))))
      throw new Error('Preparation did not return the exact chosen swaps');
  }
  if (command === 'execute') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(argument)) throw new Error('Provide the exact saved plan UUID');
    answer = await client.executePlan({ planId: argument });
  }
  if (command === 'sweep-preview' || command === 'sweep') answer = await client.sweep({ execute: command === 'sweep' });
  const print = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
  if (answer?.[Symbol.asyncIterator]) {
    for await (const event of answer) {
      process.stdout.write(print(event) + '\n');
      if (event.type === 'rejected' || (event.status !== undefined && event.status !== 'SUCCESS')) process.exitCode = 1;
      // The platform's refusal carries no code, only this reason (SDK 0.4.0 server, src/planning/strategy-grant.ts).
      if (event.type === 'rejected' && event.problems?.some(problem => /grant doesn't bind the saved strategy/.test(problem)))
        process.stderr.write('Refused before sending: the owner\'s live grant does not bind the saved strategy. Report this to the owner; '
          + 'do not retry execute or prepare a replacement plan until the owner authorizes the saved strategy by signing a grant for it. '
          + 'Saving a different strategy needs a new grant.\n');
    }
  } else process.stdout.write(print(answer) + '\n');
} catch (error) {
  // Never print request objects, tokens, headers or untrusted provider error text.
  const safe = error?.name === 'ORPCError' ? `Treasury request failed (${error.code ?? 'unknown'})` : 'Treasury client failed; check configuration, input and access';
  const unavailable = command === 'prepare' && ['NOT_FOUND', 'METHOD_NOT_SUPPORTED'].includes(error?.code)
    ? ' Chosen-swap externalPlan is unavailable on this host; do not substitute rebalance.' : '';
  process.stderr.write(`${safe}.${unavailable}${moving ? ' Execution outcome may be unknown; inspect activity and unresolved operations before another send.' : ''}\n`);
  process.exitCode = 1;
}
