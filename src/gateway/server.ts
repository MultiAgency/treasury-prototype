import lockfile from "proper-lockfile";
import { TreasuryRegistry, registrationOwner, registeredEnv, checkRegisteredAction } from "./treasury-registration.js";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIntervention, mayCall } from "./allowlist.js";
import { BadRequest, crossSite, readJson, SECURITY_HEADERS, sendFailure, sendJson as json, serveStatic } from "../../shared/http.js";
import { chainKeyLookup, challengeAnswer, clientAddress, hourlyLimit, parseSignIn, sessions, verifySignIn } from "../../shared/signin.js";
import { type AgentEntry, childEnv, hostOf, loadConfig } from "./config.js";
import { recentSignProposals } from "./proposals.js";
import { ownerOf, resolveAccess, resolveAgentAccess } from "./roles.js";
import { appendSynced } from "../synced.js";
import { canonicalHostAnswer, signingHost } from "./canonical-host.js";

/**
 * The hosted dashboard: the one public process. It signs members in, decides per request what each
 * may do from each agent's owner (a DAO's own policy, or the owner account itself), and forwards
 * allowed calls to the agent servers, which keep
 * running on loopback exactly as they do locally, each with its own agent, grant, lock and logs. The
 * gateway itself holds no grant token.
 */

const config = loadConfig();
const selfService = process.env.TREASURY_SELF_SERVICE === "true";
const registry = selfService ? new TreasuryRegistry(".treasuries", config.agents.map(a => a.port)) : null;
// One gateway owns these child processes on this host; this is not distributed fencing.
// Wait through a stopped predecessor’s stale-lock window before starting any server or child.
const registryLease = registry ? await lockfile.lock(registry.root, { lockfilePath: join(registry.root, ".gateway.lock"), stale: 60_000, realpath: true, retries: { retries: 35, factor: 1, minTimeout: 2_000, maxTimeout: 2_000 } }) : null;
const registered = registry?.list() ?? [];
for (const record of registered) config.agents.push(registry!.entry(record));
if (new Set(config.agents.map(agent => agent.name)).size !== config.agents.length) throw new Error("Configured and registered treasury names conflict");
const PORT = Number(process.env.PORT ?? 8800);
/** The host members sign in to; DASHBOARD_HOST overrides it, e.g. to test on a provider's domain before DNS moves. */
const HOST = hostOf(process.env.DASHBOARD_HOST || config.host);
/** Where the app is installed, apart from the working directory, which holds the agents' state. */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(APP, "web/dist");
// Signs every session: an empty or missing secret would let anyone forge one, so the gateway won't start.
const SECRET = process.env.SESSION_SECRET ?? "";
if (SECRET.length < 32) throw new Error("Set SESSION_SECRET to a random value of at least 32 characters before starting the gateway");
const session = sessions({ cookie: "dao_session", secret: SECRET, secure: true });

const INTERVENTIONS = join(".evidence", "interventions.jsonl");
/**
 * Recorded interventions since `since`, oldest first, and the line numbers that don't parse. An
 * unreadable line may have been a call, so it is counted, not skipped: the report can't claim none.
 */
function interventions(since: string) {
  const calls: { at: string; account: string; agent: string; path: string }[] = [];
  const corrupt: number[] = [];
  const text = existsSync(INTERVENTIONS) ? readFileSync(INTERVENTIONS, "utf8") : "";
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try { calls.push(JSON.parse(line)); } catch { corrupt.push(index + 1); }
  }
  return { calls: calls.filter((i) => i.at >= since), corrupt };
}

/** The signed-in account and what it may do with each agent it may see, or null. */
async function viewer(req: IncomingMessage) {
  const account = session.account(req);
  if (!account) return null;
  const access = await resolveAccess(account, config.agents);
  return selfService || Object.keys(access).length ? { account, access } : null;
}

/**
 * The agents a visitor may know of, each with its owner and whether that owner is a DAO (signing by
 * proposal): a signed-in viewer's own, or, signed out, only the DAOs' agents. Those are public already,
 * since every owner action is an on-chain proposal naming the agent; a wallet's agent is not.
 */
async function agentsView(me: Awaited<ReturnType<typeof viewer>>) {
  const all = await Promise.all(config.agents.map(async ({ name, owner, area }) => ({ name, owner, ...(area && { area }), dao: (await ownerOf(owner)).policy !== null })));
  return all.filter((a) => (me ? Boolean(me.access[a.name]) : a.dao && !registered.some(r => r.name === a.name)));
}

/** Forwards a call to an agent server on loopback, streaming both ways (some procedures stream events). */
function forward(req: IncomingMessage, res: ServerResponse, agent: AgentEntry, path: string, body?: string) {
  const headers: IncomingMessage["headers"] = { ...req.headers, host: `127.0.0.1:${agent.port}` };
  delete headers.origin;
  delete headers.cookie;
  delete headers.authorization;
  delete headers["x-gateway"];
  if (body !== undefined) { headers["content-length"] = String(Buffer.byteLength(body)); delete headers["transfer-encoding"]; }
  const upstream = request({ host: "127.0.0.1", port: agent.port, path: `/rpc/${path}`, method: req.method, headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, { ...answer.headers,
      "cache-control": "private, no-store" });
    answer.pipe(res);
  });
  upstream.on("error", () => json(res, 502, { error: `The ${agent.name} agent server is not answering` }));
  if (body !== undefined) upstream.end(body); else req.pipe(upstream);
}

/**
 * Sign-in challenges per connecting address per hour. The global cap in signin.ts bounds memory;
 * this keeps one client from filling it and locking every member out of sign-in.
 */
const CHALLENGES_PER_HOUR = 20;
const mayChallenge = hourlyLimit(CHALLENGES_PER_HOUR);

createServer(async (req, res) => {
  // On every answer: no other site may frame these pages (they trigger wallet signatures, so a hidden
  // frame could trick a click), types are taken as declared, no address leaks to linked sites, and
  // browsers keep to HTTPS once they have seen it.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    const url = URL.parse(req.url ?? "/", "http://gateway");
    if (!url) throw new BadRequest("Malformed request.");
    const { pathname } = url;
    const canonical = canonicalHostAnswer(req, url, HOST, config.redirect_hosts);
    if (canonical?.status === 302) return res.writeHead(302, { location: canonical.location, "cache-control": "no-store" }).end();
    if (canonical) return json(res, 421, { error: `Use https://${HOST} for sign-in and API requests.` });
    // State-changing requests must come from this site's own pages.
    if (req.method !== "GET" && crossSite(req)) return json(res, 403, { error: "Cross-site request" });

    if (pathname === "/health") return json(res, 200, { ok: true });

    const signHost = signingHost(req, HOST, config.signin_hosts);
    if (["/gw/challenge", "/gw/session"].includes(pathname) && !signHost)
      return json(res, 421, { error: "Use a configured signing host." });
    if (pathname === "/gw/challenge" && req.method === "GET") return json(res, ...challengeAnswer(signHost!, mayChallenge(clientAddress(req))));
    if (pathname === "/gw/session" && req.method === "POST") {
      const account = await verifySignIn(parseSignIn(await readJson(req)), signHost!, chainKeyLookup).catch((error: Error) => error);
      if (account instanceof Error) return json(res, 401, { error: account.message });
      const access = await resolveAccess(account, config.agents);
      if (!selfService && !Object.keys(access).length) return json(res, 403, { error: `${account} doesn't own any agent here, nor is a member of a DAO that does` });
      return json(res, 200, { account, access }, { "set-cookie": session.open(account) });
    }
    if (pathname === "/gw/logout" && req.method === "POST")
      return json(res, 200, {}, { "set-cookie": session.close() });

    if (pathname === "/gw/me") {
      const me = await viewer(req);
      return json(res, 200, { agents: await agentsView(me), invoices: config.invoices ?? null, viewer: me, ...(selfService && { selfServiceTreasury: true }) });
    }

    if (pathname === "/gw/treasuries" && req.method === "POST" && registry) {
      const account = session.account(req);
      if (!account) return json(res, 401, { error: "Sign in first" });
      const selected = await registrationOwner(account, await readJson(req), ownerOf);
      const existing = config.agents.find(a => a.owner === selected.owner && a.area === "treasury");
      if (existing) return json(res, 200, { name: existing.name });
      const record = registry.register(selected.owner, selected.kind);
      if (!config.agents.some(a => a.name === record.name)) {
        registered.push(record);
        const entry = registry.entry(record); config.agents.push(entry);
        start({ ...entry, envFile: entry.envFile! });
      }
      return json(res, 201, { name: record.name });
    }

    // A DAO's recent signing proposals, for a viewer who may see one of the agents it owns.
    if (pathname === "/gw/proposals") {
      const me = await viewer(req);
      if (!me) return json(res, 401, { error: "Sign in first", access: "session" });
      const dao = url.searchParams.get("dao") ?? "";
      const owned = config.agents.filter((a) => a.owner === dao && me.access[a.name]);
      if (!owned.length) return json(res, 403, { error: `No agent here you may see is owned by ${dao || "that account"}`, access: "procedure" });
      if (!(await ownerOf(dao)).policy) return json(res, 400, { error: `${dao} is not a DAO` });
      return json(res, 200, await recentSignProposals(dao, owned));
    }

    // Intervention history, including old operator records, for agents this viewer may execute or manage.
    if (pathname === "/gw/interventions") {
      const me = await viewer(req);
      const operated = new Set(Object.entries(me?.access ?? {}).filter(([, a]) => a.canExecute || a.canManage).map(([agent]) => agent));
      if (!operated.size) return json(res, me ? 403 : 401, { error: "Execution or management permission required", access: me ? "procedure" : "session" });
      const { calls, corrupt } = interventions(url.searchParams.get("since") ?? "");
      // An unreadable line can't be attributed to an agent, so every eligible viewer is told it exists.
      return json(res, 200, { calls: calls.filter((c) => operated.has(c.agent)), corrupt });
    }
    // Every gateway path is listed above; anything else under /gw/ is no page either.
    if (pathname.startsWith("/gw/")) return json(res, 404, { error: "Not found" });

    const call = pathname.match(/^\/a\/([a-z0-9-]+)\/rpc\/(.+)$/);
    if (call) {
      const agent = config.agents.find((a) => a.name === call[1]);
      if (!agent) return json(res, 404, { error: "No such agent" });
      const account = session.account(req);
      if (!account) return json(res, 401, { error: "Sign in first", access: "session" });
      const access = await resolveAgentAccess(account, agent);
      if (!access) return json(res, 403, { error: `${account} may not see the ${agent.name} agent`, access: "agent" });
      if (!mayCall(access, call[2]!)) return json(res, 403, { error: "This account does not have permission for this action", access: "procedure" });
      const registration = registered.find(r => r.name === agent.name);
      if (registration && ["treasury/link", "treasury/unlink"].includes(call[2]!)) return json(res, 403, { error: "This treasury is bound to its selected owner." });
      let forwardedBody: string | undefined;
      if (registration && call[2] === "owner/prepare") {
        const body = await readJson(req); checkRegisteredAction(registration, body); forwardedBody = JSON.stringify(body);
      }
      // Preserve which calls count as interventions: recorded before they run, or not run.
      if (isIntervention(call[2]!)) {
        try {
          mkdirSync(".evidence", { recursive: true });
          appendSynced(INTERVENTIONS, { at: new Date().toISOString(), account, agent: agent.name, path: call[2] });
        } catch {
          return json(res, 503, { error: "The action could not be recorded, so it was not run" });
        }
      }
      return forward(req, res, agent, call[2]!, forwardedBody);
    }

    return serveStatic(res, DIST, pathname.replace(/^\/a\/[a-z0-9-]+/, "") || "/");
  } catch (error) {
    sendFailure(res, error);
  }
}).listen(PORT, () => console.log(`Dashboard for ${config.agents.map((a) => `${a.name} (${a.owner})`).join(", ")} on port ${PORT}, signing in to ${HOST}`));

const children = new Set<ChildProcess>();

/**
 * Runs an agent server on loopback, restarting it if it exits: soon after a crash, then backing off
 * up to 5 minutes while it keeps failing to start (such as when another server holds its agent).
 */
function start(agent: AgentEntry & { envFile: string }, delay = 5_000) {
  const started = Date.now();
  const record = registered.find(r => r.name === agent.name);
  const child = spawn(join(APP, "node_modules/.bin/tsx"), ["--env-file-if-exists=.env", join(APP, "src/server.ts")], {
    env: record ? registeredEnv(agent, process.env) : childEnv(agent),
    ...(record && { cwd: registry!.directory(record) }),
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.add(child);
  child.on("exit", (code) => {
    children.delete(child);
    const next = Date.now() - started < 60_000 ? Math.min(delay * 2, 300_000) : 5_000;
    console.error(`Agent server ${agent.name} exited (${code}); restarting in ${next / 1000} s`);
    setTimeout(() => start(agent, next), next);
  });
}
for (const agent of config.agents) if (agent.envFile) start({ ...agent, envFile: agent.envFile });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const child of children) child.removeAllListeners("exit").kill(signal);
    registryLease?.();
    process.exit(0);
  });
