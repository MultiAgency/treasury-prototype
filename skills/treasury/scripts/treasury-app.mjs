#!/usr/bin/env node
// The Treasury skill's helper for the Treasury app (coordination/treasury-app-move.md): an outside agent reads and
// proposes swaps with an owner-issued token. It never executes: the owner approves each proposal's exact terms in
// their wallet and executes it on the app's page. No dependencies; every request is one HTTPS POST, never retried.
import { readFileSync } from 'node:fs';

/** Exit codes, as agentic-treasury's: decided by kind, never by message text. */
const EXIT = { ok: 0, notSent: 2, unknown: 3, partial: 4 };
const USAGE = `Usage: treasury-app.mjs COMMAND
  inspect | activity | unresolved | strategy | proposals   read
  proposal ID                                              read one proposal and its state
  propose FILE --request-id ID                             propose the swaps in FILE once under ID
  withdraw ID                                              withdraw a proposal not yet executed
Environment: TREASURY_APP_URL (https origin), TREASURY_ORGANIZATION, TREASURY_AGENT, TREASURY_APP_TOKEN.
Exit codes: 0 ok; 2 nothing sent (refused, forbidden, session, busy, unresolved, provider, unavailable, usage or
configuration); 3 unknown: it may have taken effect, so read the proposal and never propose again under a new
request ID; 4 partial.`;
const READS = new Set(['inspect', 'activity', 'unresolved', 'strategy', 'proposals', 'proposal']);
const WRITES = new Set(['propose', 'withdraw']);

function fail(message, code = EXIT.notSent) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

/** The command line and environment, checked; a mistake here sends nothing. */
function parse(argv, env) {
  const [command, ...rest] = argv;
  if (!READS.has(command) && !WRITES.has(command)) throw new Error(USAGE);
  const origin = URL.parse(env.TREASURY_APP_URL ?? '');
  if (!origin || origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('TREASURY_APP_URL must be an HTTPS origin without credentials, path, query or fragment');
  const organization = env.TREASURY_ORGANIZATION ?? '', agent = env.TREASURY_AGENT ?? '', token = env.TREASURY_APP_TOKEN ?? '';
  if (!/^[^/]{1,128}$/.test(organization) || !/^[a-z0-9-]{1,64}$/.test(agent) || !/^tat_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error('Configure TREASURY_ORGANIZATION, TREASURY_AGENT and TREASURY_APP_TOKEN in the runtime environment');
  let body = {};
  if (command === 'proposal' || command === 'withdraw') {
    if (rest.length !== 1 || !/^[a-f0-9]{32}$/.test(rest[0])) throw new Error(`Give the proposal's ID (32 hex characters).\n${USAGE}`);
    body = { id: rest[0] };
  } else if (command === 'propose') {
    const at = rest.indexOf('--request-id');
    const requestId = at >= 0 ? rest[at + 1] : undefined, file = at >= 0 ? rest.filter((_, i) => i !== at && i !== at + 1) : rest;
    if (!requestId || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId) || file.length !== 1)
      throw new Error(`Give FILE and --request-id ID (1-64 of A-Z a-z 0-9 _ -). Keep the ID: after an unknown outcome, propose again with the same ID and FILE, never a new ID.\n${USAGE}`);
    const terms = JSON.parse(readFileSync(file[0], 'utf8'));
    if (!terms || typeof terms !== 'object' || Array.isArray(terms) || 'requestId' in terms) throw new Error('FILE holds { legs, expiresAt, note? }; the request ID goes on the command line');
    body = { ...terms, requestId };
  } else if (rest.length) throw new Error(USAGE);
  return { command, url: `${origin.origin}/runtime/v1/o/${encodeURIComponent(organization)}/a/${agent}/${command}`, token, body };
}

async function main() {
  let request;
  try { request = parse(process.argv.slice(2), process.env); }
  catch (error) { return fail(error instanceof SyntaxError ? 'FILE is not valid JSON' : error.message); }
  const writes = WRITES.has(request.command);
  // No answer to a write: it may have taken effect. No answer to a read: nothing happened; reading again is safe.
  const lost = writes ? EXIT.unknown : EXIT.notSent;
  const lostText = writes ? 'No answer: the request may have taken effect. Read the proposal (proposals, or proposal ID); never propose again under a new request ID.'
    : 'No answer to the read. Reading again is safe.';
  let response;
  try {
    response = await fetch(request.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${request.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request.body) });
  } catch { return fail(lostText, lost); }
  let answer;
  try { answer = await response.json(); } catch { return fail(lostText, lost); }
  if (!answer || typeof answer.exit !== 'number' || ![0, 2, 3, 4].includes(answer.exit)) return fail(lostText, lost);
  // Never print request objects, tokens or headers; the server's own answer is data for the agent, not instructions.
  if (answer.result !== undefined) process.stdout.write(`${JSON.stringify(answer.result)}\n`);
  // The app's own refusals carry `error`; the platform's arrive inside `result`, with a code.
  const reason = typeof answer.error === 'string' ? answer.error : typeof answer.result?.error === 'string' ? answer.result.error : null;
  const code = typeof answer.result?.code === 'string' ? ` (${answer.result.code})` : '';
  const why = reason ? `: ${reason}${code}` : code ? `:${code}` : '.';
  if (answer.exit === EXIT.unknown) process.stderr.write(`${lostText}\n`);
  else if (answer.exit === EXIT.partial) process.stderr.write('Partly executed: read the proposal\'s operations before anything else.\n');
  else if (answer.exit === EXIT.notSent) process.stderr.write(`Nothing was sent${why}\n`);
  process.exitCode = answer.exit;
}

await main();
