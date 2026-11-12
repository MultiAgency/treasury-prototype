// Preloaded into the packaged Treasury skill helper (`node --import`): its fetch is answered in-process by an oRPC
// handler for workspace `portfolio`, so no socket, host or credential is involved. `HELPER_STUB_EVENTS` is the
// executePlan event stream to answer; every request the helper makes is appended to `HELPER_STUB_CALLS`.
import { appendFileSync } from 'node:fs';
import { os } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';

const events = JSON.parse(process.env.HELPER_STUB_EVENTS ?? '[]');
const handler = new RPCHandler({
  executePlan: os.handler(async function* () { for (const event of events) yield event; }),
});
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  appendFileSync(process.env.HELPER_STUB_CALLS, `${new URL(request.url).pathname}\n`);
  const { matched, response } = await handler.handle(request, { prefix: '/machine/v1/a/portfolio/rpc' });
  return matched ? response : new Response(null, { status: 404 });
};
