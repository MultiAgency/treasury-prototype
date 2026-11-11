import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname } from "node:path";
import { crossSite, readJson, SECURITY_HEADERS, sendFailure, sendJson as json, serveStatic } from "../shared/http.js";
import { challengeAnswer, clientAddress, hourlyLimit, type KeyLookup, parseSignIn, sessions, verifySignIn } from "../shared/signin.js";
import { RuntimeTokens, type RuntimeScope } from "./runtime-tokens.js";
import { randomBytes } from "node:crypto";
import { accessOf, consentMessage, limitOrderText, mayCall, proposalText, type DaoPolicy } from "@multiagency/treasury-app-sdk";
import { daoPolicy as readDaoPolicy } from "../src/chain.js";
import { commandExit, EXIT, executionExit, type Read, type TreasuryApp } from "./treasury-app.js";

/** Sign-in challenges one address may ask for per hour. */
export const CHALLENGES_PER_HOUR = 30;
/** How long the owner has to sign a prepared consent text, and how many may wait at once. */
export const CONSENT_SIGNING_MS = 10 * 60_000, MAX_PENDING_CONSENTS = 1_000, MAX_PENDING_PER_OWNER = 5;
/** The consent lifetimes the app offers, in days: shorter than the platform's limit (366), for delegated proposals. */
export const CONSENT_DAYS = { min: 1, max: 90, default: 30 };
/** Calls one agent token may make per hour; a request limit, not a spending control. */
export const RUNTIME_CALLS_PER_HOUR = 600;

/**
 * What each agent command does and the token scope and consent scope it needs. No command executes anything: the owner
 * executes an approved proposal (coordination/treasury-app-move.md, Answers 2).
 */
const COMMANDS: Record<string, { scope: RuntimeScope; consent: "read" | "treasury"; read?: Read }> = {
  inspect: { scope: "read", consent: "read", read: "overview" },
  activity: { scope: "read", consent: "read", read: "activity" },
  unresolved: { scope: "read", consent: "read", read: "unresolved" },
  strategy: { scope: "read", consent: "treasury", read: "strategy/get" },
  proposal: { scope: "read", consent: "treasury" },
  proposals: { scope: "read", consent: "treasury" },
  propose: { scope: "propose", consent: "treasury" },
  withdraw: { scope: "propose", consent: "treasury" },
};

/**
 * The Treasury app's own server (coordination/treasury-app-move.md, Answers 3). The owner signs in here with their
 * wallet, because the platform host serves no owner sign-in, and issues tokens for outside agents. It holds no money
 * state and starts no executor; agent calls go to the platform through `app/treasury-app.ts`, which enforces the
 * owner's consent, signed terms, policy, grant and strategy. Its session cookie is its own, so a session from another
 * app on the same domain never counts here.
 */
export function createAppServer({ host, secret, keyLookup, platform, tokens, web, secure = true, daoPolicy = readDaoPolicy }:
  { host: string; secret: string; keyLookup: KeyLookup; platform: TreasuryApp; tokens: RuntimeTokens; web?: string; secure?: boolean;
    daoPolicy?: (dao: string) => Promise<DaoPolicy | null> }) {
  if (secret.length < 32) throw new Error("Set SESSION_SECRET to a random value of at least 32 characters before starting the Treasury app");
  const session = sessions({ cookie: "treasury_app_session", secret, secure });
  const mayChallenge = hourlyLimit(CHALLENGES_PER_HOUR);
  const mayRun = hourlyLimit(RUNTIME_CALLS_PER_HOUR);
  /** Consent texts this app prepared, by nonce: only these are relayed, once, by the owner they were prepared for. */
  const pending = new Map<string, { account: string; organization: string; agent: string; message: string; recipient: string; until: number }>();

  /**
   * The agent's owner and provider ID now, and the consent scopes the app holds for it in this Organization: read from
   * the platform on every call, never cached. Null when the platform doesn't answer.
   */
  async function authority(organization: string, agent: string) {
    const [who, held] = await Promise.all([platform.identity(agent), platform.consents(organization)]);
    if (!who.ok || !held.ok || !who.value.agentId) return null;
    const now = Date.now(), { owner, agentId } = who.value;
    const live = held.value.consents.filter(c => c.organization === organization && c.agent === agent && c.owner === owner
      && c.agentId === agentId && c.host === who.value.host && c.deployment === who.value.deployment
      && (c.signer ?? "wallet") === (who.value.signer ?? "wallet") && !c.revoked && c.expiresAt > now);
    // `host`: the platform's signing host, the NEP-413 recipient of the owner's signature over a proposal.
    return { owner, agentId, host: who.value.host, deployment: who.value.deployment,
      signer: who.value.signer ?? "wallet", scopes: new Set(live.flatMap(c => c.scopes)) };
  }

  /** Each order call checks current membership itself: the service credential admits the app, not a DAO member. */
  async function orderAuthority(account: string, organization: string, agent: string) {
    const [now, discovery] = await Promise.all([authority(organization, agent), platform.discovery()]);
    if (!now) return null;
    // Never infer membership from Everyone, or treat an unreadable DAO policy as a wallet owner.
    let policy: DaoPolicy | null;
    try { policy = now.signer === "dao" ? await daoPolicy(now.owner) : null; }
    catch { return null; }
    const access = now.signer === "dao" && !policy ? null : accessOf(account, { account: now.owner, policy, signer: now.owner });
    return { ...now, access, capable: discovery.ok && discovery.value.capabilities?.includes("treasury-limit-orders-v1") === true,
      consented: now.scopes.has("treasury") && now.scopes.has("treasury-orders") };
  }

  /** Owner order controls. All nine procedures stay behind the server's app client and current consent. */
  async function orders(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const account = session.account(req);
    if (!account) return json(res, 401, { error: "Sign in first" });
    const match = pathname.match(/^\/app\/orders(?:\/(access|quote|[a-f0-9]{32})(?:\/(decide|place|cancel(?:\/continue)?|refresh|dao))?|\/dao\/([^/]{1,256})|\/(consent)(?:\/([^/]{1,256}))?)?$/);
    if (!match) return json(res, 404, { error: "Not found" });
    const [, target, action, encodedHash, consentAction, encodedConsentHash] = match;
    const url = new URL(req.url ?? "/", "http://app.invalid");
    const reading = target === "access" || encodedHash !== undefined || encodedConsentHash !== undefined
      || (!consentAction && target !== "quote" && !action && req.method === "GET");
    if (req.method !== (reading ? "GET" : "POST")) return json(res, 405, { error: reading ? "Use GET" : "Use POST" });
    if (target && /^[a-f0-9]{32}$/.test(target) && !action && req.method !== "GET") return json(res, 405, { error: "Use GET" });
    const body = req.method === "POST" ? await readJson(req) : {};
    const organization = String((req.method === "POST" ? body.organization : url.searchParams.get("organization")) ?? "");
    const agent = String((req.method === "POST" ? body.agent : url.searchParams.get("agent")) ?? "");
    if (!organization || !/^[a-z0-9-]{1,64}$/.test(agent)) return json(res, 400, { error: "Give organization and agent." });
    const now = await orderAuthority(account, organization, agent);
    if (!now) return json(res, 503, { error: "The platform didn't confirm the agent's owner and consent. Nothing was sent.", exit: EXIT.notSent });
    if (!now.access) return json(res, 403, { error: "Only the current owner or an admitted DAO member may access orders.", exit: EXIT.notSent });
    if (target === "access") return json(res, 200, {
      capable: now.capable, consented: now.consented, owner: now.owner, signer: now.signer,
      mayRead: now.capable && now.consented,
      mayPrepare: now.capable && now.consented && mayCall(now.access, "limitOrders/create"),
      mayExecute: now.capable && now.consented && mayCall(now.access, "limitOrders/place"),
      mayVote: now.access.canVote, mayConsent: now.signer === "dao" ? now.access.canPropose : account === now.owner,
    });
    if (!now.capable) return json(res, 409, { error: "This host does not advertise treasury-limit-orders-v1.", exit: EXIT.notSent });
    const respond = (result: { ok: boolean; kind?: string }) => json(res, 200, { exit: commandExit(result), result });
    if (consentAction) {
      if (now.signer !== "dao" || !now.access.canPropose) return json(res, 403, { error: "A DAO member with proposal rights must file or follow this consent vote." });
      if (encodedConsentHash !== undefined) {
        let hash: string;
        try { hash = decodeURIComponent(encodedConsentHash); } catch { return json(res, 400, { error: "Invalid consent request ID." }); }
        const saved = platform.daoOrderConsentRequest(organization, agent, hash);
        if (!saved || saved.dao !== now.owner || saved.agentId !== now.agentId)
          return json(res, 404, { error: "No saved consent vote for this DAO and agent." });
        return respond(await platform.daoOrderConsentState(organization, agent, hash));
      }
      const days = body.days ?? CONSENT_DAYS.default;
      if (typeof days !== "number" || !Number.isInteger(days) || days < CONSENT_DAYS.min || days > CONSENT_DAYS.max)
        return json(res, 400, { error: `Choose a consent lifetime from ${CONSENT_DAYS.min} to ${CONSENT_DAYS.max} days.` });
      const message = consentMessage({ host: now.host, deployment: now.deployment, organization, owner: now.owner,
        agent, agentId: now.agentId, scopes: ["read", "treasury", "treasury-orders"], expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() });
      const result = await platform.daoOrderConsentFile(message);
      return json(res, 200, { exit: commandExit(result), result, message });
    }
    if (!now.consented) return json(res, 403, { error: "Sign a new consent containing treasury and treasury-orders first.", exit: EXIT.notSent });
    if (encodedHash !== undefined) {
      let hash: string;
      try { hash = decodeURIComponent(encodedHash); } catch { return json(res, 400, { error: "Invalid vote request ID." }); }
      const saved = platform.daoOrderRequest(organization, agent, hash);
      // state() can relay a signature, so bind it to this agent and DAO before making that call.
      if (!saved || saved.dao !== now.owner || saved.agentId !== now.agentId || now.signer !== "dao")
        return json(res, 404, { error: "No saved vote request for this DAO and agent." });
      if (!now.access.canPropose) return json(res, 403, { error: "Your DAO role cannot follow an order vote relay." });
      return respond(await platform.daoOrderState(organization, agent, saved.order, hash));
    }
    const id = target && /^[a-f0-9]{32}$/.test(target) ? target : undefined;
    if (action === "dao") {
      if (now.signer !== "dao" || !now.access.canPropose) return json(res, 403, { error: "A DAO member with proposal rights must file this vote." });
      if (body.verdict !== "approve" && body.verdict !== "reject") return json(res, 400, { error: "Give verdict approve or reject." });
      const filed = await platform.daoOrderFile(organization, agent, id!, body.verdict);
      if (filed.ok && (filed.value.request.dao !== now.owner || filed.value.request.agentId !== now.agentId))
        return json(res, 502, { error: "The platform returned a vote for another DAO or agent identity." });
      return respond(filed);
    }
    const procedure = action === "decide" ? body.verdict === "reject" ? "limitOrders/reject" : "limitOrders/approve"
      : action === "place" ? "limitOrders/place" : (action === "cancel" || action === "cancel/continue") ? "limitOrders/cancel"
      : action === "refresh" ? "limitOrders/refresh" : target === "quote" ? "limitOrders/quote"
      : id ? "limitOrders/get" : req.method === "GET" ? "limitOrders/list" : "limitOrders/create";
    if (!mayCall(now.access, procedure)) return json(res, 403, { error: "Your current role cannot perform this order action.", exit: EXIT.notSent });
    if (!id) {
      if (req.method === "GET") return respond(await platform.orderList(organization, agent));
      const { organization: _organization, agent: _agent, ...input } = body;
      return respond(target === "quote" ? await platform.orderQuote(organization, agent, input as never)
        : await platform.orderCreate(organization, agent, input as never));
    }
    if (!action) {
      const result = await platform.orderGet(organization, agent, id);
      const decisionHeld = platform.decisionHeld("order", organization, agent, id);
      return json(res, 200, { exit: commandExit(result), result, decisionHeld, attempts: platform.orderAttempted(organization, agent, id),
        ...(result.ok && !decisionHeld && { sign: { recipient: now.host, approve: limitOrderText(result.value, "approve"), reject: limitOrderText(result.value, "reject") } }) });
    }
    if (action === "decide") {
      const { verdict, signed } = body as { verdict?: unknown; signed?: Record<string, unknown> };
      if ((verdict !== "approve" && verdict !== "reject") || !signed || typeof signed !== "object"
        || !["message", "nonce", "publicKey", "signature"].every(key => typeof signed[key] === "string"))
        return json(res, 400, { error: "Give a verdict and the wallet's signed message, nonce, publicKey and signature." });
      const result = await platform.orderDecide(organization, agent, id, verdict, signed as never);
      const decisionHeld = platform.decisionHeld("order", organization, agent, id);
      return json(res, 200, { exit: !result.ok && decisionHeld ? EXIT.unknown : commandExit(result), result, decisionHeld });
    }
    const result = action === "place" ? await platform.orderPlace(organization, agent, id)
      : action === "cancel" ? await platform.orderCancel(organization, agent, id)
      : action === "cancel/continue" ? await platform.orderContinueCancel(organization, agent, id) : await platform.orderRefresh(organization, agent, id);
    return json(res, 200, { exit: commandExit(result), result, decisionHeld: platform.decisionHeld("order", organization, agent, id) });
  }

  /** An agent's call: its token, then the platform's current answer for this agent, then the relay. */
  async function runtime(req: IncomingMessage, res: ServerResponse, organization: string, agent: string, command: string) {
    if (req.headers.origin !== undefined || req.headers.cookie !== undefined)
      return json(res, 403, { error: "Use an agent client without browser credentials.", exit: EXIT.notSent });
    if (req.method !== "POST") return json(res, 405, { error: "Use POST", exit: EXIT.notSent }, { allow: "POST" });
    const spec = COMMANDS[command];
    if (!spec) return json(res, 404, { error: "No such command", exit: EXIT.notSent });
    const token = tokens.authenticate(req.headers.authorization, host);
    if (!token) return json(res, 401, { error: "Invalid, expired or revoked token", exit: EXIT.notSent }, { "www-authenticate": "Bearer" });
    if (!mayRun(token.id)) return json(res, 429, { error: "Token request limit reached", exit: EXIT.notSent }, { "retry-after": "3600" });
    if (token.organization !== organization || token.agent !== agent) return json(res, 403, { error: "This token is for another agent.", exit: EXIT.notSent });
    if (!token.scopes.includes(spec.scope)) return json(res, 403, { error: `This token lacks the ${spec.scope} scope.`, exit: EXIT.notSent });
    const body = await readJson(req);
    const now = await authority(organization, agent);
    if (!now) return json(res, 503, { error: "The platform didn't confirm the agent's owner and consent. Nothing was sent; try again.", exit: EXIT.notSent });
    if (now.owner !== token.owner || now.agentId !== token.agentId)
      return json(res, 403, { error: "The agent's owner or identity changed since this token was issued.", exit: EXIT.notSent });
    if (!now.scopes.has(spec.consent)) return json(res, 403, { error: `The owner's consent doesn't include ${spec.consent}.`, exit: EXIT.notSent });
    const id = typeof body.id === "string" ? body.id : "";
    const result = spec.read ? await platform.read(organization, agent, spec.read)
      : command === "proposal" ? await platform.get(organization, agent, id)
      : command === "proposals" ? await platform.list(organization, agent)
      : command === "withdraw" ? await platform.withdraw(organization, agent, id)
      : await platform.propose(organization, agent, body as never);
    return json(res, 200, { exit: commandExit(result), result });
  }

  /** The owner's management of agent tokens: only the agent's current owner, with a live consent for it. */
  async function manage(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const account = session.account(req);
    if (!account) return json(res, 401, { error: "Sign in first" });
    const revoke = pathname.match(/^\/app\/tokens\/([0-9a-f-]{36})$/);
    if (revoke && req.method === "DELETE")
      return tokens.revoke(revoke[1]!, account) ? json(res, 200, { revoked: true }) : json(res, 404, { error: "No such token" });
    if (pathname !== "/app/tokens") return json(res, 404, { error: "Not found" });
    const url = new URL(req.url ?? "/", "http://app.invalid");
    const body = req.method === "POST" ? await readJson(req) : {};
    const organization = String(req.method === "POST" ? body.organization ?? "" : url.searchParams.get("organization") ?? "");
    const agent = String(req.method === "POST" ? body.agent ?? "" : url.searchParams.get("agent") ?? "");
    const now = await authority(organization, agent);
    if (!now) return json(res, 503, { error: "The platform didn't confirm the agent's owner and consent. Try again." });
    if (now.owner !== account) return json(res, 403, { error: "Only the agent's owner manages its tokens." });
    if (req.method === "GET") return json(res, 200, { tokens: tokens.list(account, organization, agent) });
    if (req.method !== "POST") return json(res, 405, { error: "Use GET or POST, or DELETE on a token" });
    const scopes = Array.isArray(body.scopes) ? body.scopes : [];
    if (!now.scopes.has("read") || (scopes.includes("propose") && !now.scopes.has("treasury")))
      return json(res, 403, { error: "Connect the agent with a consent covering these scopes first." });
    return json(res, 201, tokens.issue(body as never, { owner: account, agentId: now.agentId, host }));
  }

  /**
   * The owner's proposals: read one with the exact texts the platform accepts, relay a signed decision, and execute an
   * approved one (coordination/treasury-app-move.md, Answers 2). Only the agent's current owner, under a live
   * `treasury` consent. The texts and their recipient come from the platform's own proposal and host, never from the
   * caller; the relay refuses any other signed text.
   */
  async function proposals(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const account = session.account(req);
    if (!account) return json(res, 401, { error: "Sign in first" });
    // Proposal IDs are 32 hex characters (the SDK's `proposalId`).
    const match = pathname.match(/^\/app\/proposals(?:\/([a-f0-9]{32})(?:\/(decide|execute))?)?$/);
    if (!match) return json(res, 404, { error: "Not found" });
    const [, id, action] = match;
    if ((action ? "POST" : "GET") !== req.method) return json(res, 405, { error: action ? "Use POST" : "Use GET" });
    const url = new URL(req.url ?? "/", "http://app.invalid");
    const body = req.method === "POST" ? await readJson(req) : {};
    const organization = String((req.method === "POST" ? body.organization : url.searchParams.get("organization")) ?? "");
    const agent = String((req.method === "POST" ? body.agent : url.searchParams.get("agent")) ?? "");
    const now = await authority(organization, agent);
    if (!now) return json(res, 503, { error: "The platform didn't confirm the agent's owner and consent. Nothing was sent; try again.", exit: EXIT.notSent });
    if (now.owner !== account) return json(res, 403, { error: "Only the agent's owner sees and decides its proposals.", exit: EXIT.notSent });
    if (!now.scopes.has("treasury")) return json(res, 403, { error: "The owner's consent doesn't include treasury.", exit: EXIT.notSent });
    if (!id) {
      const listed = await platform.list(organization, agent);
      return json(res, 200, { exit: commandExit(listed), result: listed });
    }
    if (!action) {
      const read = await platform.get(organization, agent, id);
      const decisionHeld = platform.decisionHeld("proposal", organization, agent, id);
      // A proposed view can race an in-flight decision. Only this app's durable attempt evidence closes signing.
      return json(res, 200, { exit: commandExit(read), result: read, decisionHeld,
        ...(read.ok && !decisionHeld && { sign: { recipient: now.host,
          approve: proposalText(read.value, "approve"), reject: proposalText(read.value, "reject") } }) });
    }
    if (action === "decide") {
      const { verdict, signed } = body as { verdict?: unknown; signed?: Record<string, unknown> };
      if ((verdict !== "approve" && verdict !== "reject") || !signed || typeof signed !== "object"
        || !["message", "nonce", "publicKey", "signature"].every(key => typeof signed[key] === "string"))
        return json(res, 400, { error: "Give verdict approve or reject, and the wallet's signed message, nonce, publicKey and signature.", exit: EXIT.notSent });
      const decided = await platform.decide(organization, agent, id, verdict, signed as never);
      const decisionHeld = platform.decisionHeld("proposal", organization, agent, id);
      return json(res, 200, { exit: !decided.ok && decisionHeld ? EXIT.unknown : commandExit(decided), result: decided, decisionHeld });
    }
    // The owner's own Execute: one attempt; a lost answer is read back, never retried.
    const ran = await platform.execute(organization, agent, id);
    return json(res, 200, { exit: executionExit(ran), result: ran });
  }

  /**
   * Connecting an agent to the app: the agent's current owner signs the consent text this app builds with the SDK's
   * `consentMessage` (read + treasury; `treasury-execute` only when asked), for the platform's host; the app submits
   * exactly that signed text. Also the agent's consents, and revoking one.
   */
  async function connect(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const account = session.account(req);
    if (!account) return json(res, 401, { error: "Sign in first" });
    const url = new URL(req.url ?? "/", "http://app.invalid");
    const revoking = pathname.match(/^\/app\/connect\/([a-f0-9]{64})$/);
    if (pathname === "/app/connect/prepare" && req.method === "POST") {
      const body = await readJson(req);
      const organization = String(body.organization ?? ""), agent = String(body.agent ?? "");
      const days = body.days === undefined ? CONSENT_DAYS.default : body.days;
      if (!organization || !/^[a-z0-9-]{1,64}$/.test(agent) || typeof days !== "number" || !Number.isInteger(days) || days < CONSENT_DAYS.min || days > CONSENT_DAYS.max
        || (body.execute !== undefined && typeof body.execute !== "boolean") || (body.orders !== undefined && typeof body.orders !== "boolean")
        || (body.orders === true && body.execute === true))
        return json(res, 400, { error: `Give organization, agent, optionally days (${CONSENT_DAYS.min}-${CONSENT_DAYS.max}), execute or orders (true or false); request orders separately from execute.` });
      const who = await platform.identity(agent);
      if (!who.ok) return json(res, 503, { error: "The platform didn't confirm the agent's owner. Try again." });
      if (who.value.owner !== account) return json(res, 403, { error: "Only the agent's owner connects it." });
      if (!who.value.agentId) return json(res, 409, { error: "The agent isn't created yet." });
      const now = Date.now();
      for (const [nonce, entry] of pending) if (entry.until <= now) pending.delete(nonce);
      // One owner can't crowd out others: each has a few prepared texts waiting at most.
      if ([...pending.values()].filter(entry => entry.account === account).length >= MAX_PENDING_PER_OWNER)
        return json(res, 429, { error: "You have several consents waiting for a signature. Sign or wait for them to expire, then prepare again." });
      if (pending.size >= MAX_PENDING_CONSENTS) return json(res, 429, { error: "Too many consents waiting for a signature. Try again later." });
      // Order authority is a distinct, explicit consent. It never inherits unattended plan execution.
      if (body.orders === true) {
        const discovery = await platform.discovery();
        if (!discovery.ok || !discovery.value.capabilities?.includes("treasury-limit-orders-v1"))
          return json(res, 409, { error: "This host does not advertise treasury-limit-orders-v1." });
        if (who.value.signer === "dao") return json(res, 403, { error: "A DAO must approve its order consent by vote." });
      }
      const scopes: ("read" | "treasury" | "treasury-execute" | "treasury-orders")[] = body.orders === true
        ? ["read", "treasury", "treasury-orders"] : body.execute === true ? ["read", "treasury", "treasury-execute"] : ["read", "treasury"];
      const message = consentMessage({ host: who.value.host, deployment: who.value.deployment, organization, owner: account, agent,
        agentId: who.value.agentId, scopes, expiresAt: new Date(now + days * 86_400_000).toISOString() });
      const nonce = randomBytes(32).toString("base64");
      pending.set(nonce, { account, organization, agent, message, recipient: who.value.host, until: now + CONSENT_SIGNING_MS });
      return json(res, 200, { message, recipient: who.value.host, nonce, scopes });
    }
    if (pathname === "/app/connect" && req.method === "POST") {
      const body = await readJson(req);
      const nonce = typeof body.nonce === "string" ? body.nonce : "", entry = pending.get(nonce);
      if (!entry || entry.until <= Date.now() || entry.account !== account)
        return json(res, 409, { error: "This consent wasn't prepared here for you, or it expired. Prepare it again." });
      if (typeof body.publicKey !== "string" || typeof body.signature !== "string") return json(res, 400, { error: "Give the wallet's publicKey and signature." });
      const stored = await platform.submitConsent({ message: entry.message, nonce, publicKey: body.publicKey, signature: body.signature });
      // No answer: the platform may have stored it. Keep the prepared text, so the same signed body can be sent again.
      if (!stored.ok && stored.kind === "unavailable")
        return json(res, 503, { error: "The platform didn't answer. Submit the same signature again; it is the same consent." });
      pending.delete(nonce);
      return stored.ok ? json(res, 201, { consent: stored.value.consent })
        : json(res, stored.kind === "refused" ? stored.status : stored.kind === "forbidden" ? 403 : 401, { error: stored.error });
    }
    const organization = String(url.searchParams.get("organization") ?? ""), agent = String(url.searchParams.get("agent") ?? "");
    if ((pathname === "/app/connect" && req.method === "GET") || (revoking && req.method === "DELETE")) {
      const [who, held] = await Promise.all([platform.identity(agent), platform.consents(organization)]);
      if (!who.ok || !held.ok) return json(res, 503, { error: "The platform didn't answer. Try again." });
      if (who.value.owner !== account) return json(res, 403, { error: "Only the agent's owner sees or revokes its consents." });
      const mine = held.value.consents.filter(c => c.organization === organization && c.agent === agent && c.owner === account);
      if (!revoking) return json(res, 200, { consents: mine });
      if (!mine.some(c => c.id === revoking[1])) return json(res, 404, { error: "No such consent for this agent" });
      const revoked = await platform.revokeConsent(revoking[1]!);
      return revoked.ok ? json(res, 200, { revoked: true }) : json(res, 503, { error: "The platform didn't confirm the revocation. Check the agent's consents again." });
    }
    return json(res, 404, { error: "Not found" });
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = new URL(req.url ?? "/", "http://app.invalid");
    if (pathname === "/health") return json(res, 200, { ok: true });
    // Sign-in and tokens are bound to this host: a wallet's signature names it, so another Host would sign for someone else's site.
    if (req.headers.host?.toLowerCase() !== host.toLowerCase()) return json(res, 421, { error: "Use this app's own host." });
    const call = pathname.match(/^\/runtime\/v1\/o\/([^/]{1,128})\/a\/([a-z0-9-]{1,64})\/([a-z]+)$/);
    if (call) {
      let organization: string;
      try { organization = decodeURIComponent(call[1]!); } catch { return json(res, 400, { error: "The Organization in the path is not valid.", exit: EXIT.notSent }); }
      return runtime(req, res, organization, call[2]!, call[3]!);
    }
    if (req.method !== "GET" && crossSite(req, host)) return json(res, 403, { error: "Cross-site request" });

    if (pathname === "/app/challenge" && req.method === "GET") return json(res, ...challengeAnswer(host, mayChallenge(clientAddress(req))));
    if (pathname === "/app/session" && req.method === "POST") {
      const account = await verifySignIn(parseSignIn(await readJson(req)), host, keyLookup).catch((error: Error) => error);
      if (account instanceof Error) return json(res, 401, { error: account.message });
      return json(res, 200, { account }, { "set-cookie": session.open(account) });
    }
    if (pathname === "/app/logout" && req.method === "POST") return json(res, 200, { account: null }, { "set-cookie": session.close() });
    if (pathname === "/app/me" && req.method === "GET") {
      const account = session.account(req);
      return account ? json(res, 200, { account }) : json(res, 401, { error: "Sign in first" });
    }
    if (pathname === "/app/tokens" || pathname.startsWith("/app/tokens/")) return manage(req, res, pathname);
    if (pathname === "/app/proposals" || pathname.startsWith("/app/proposals/")) return proposals(req, res, pathname);
    if (pathname === "/app/orders" || pathname.startsWith("/app/orders/")) return orders(req, res, pathname);
    if (pathname === "/app/connect" || pathname.startsWith("/app/connect/")) return connect(req, res, pathname);
    // The owner's page (web/'s `proposals` entry) and its assets; never the gateway's index.html.
    if (web && req.method === "GET" && pathname === "/") return serveStatic(res, web, "/proposals.html");
    // Only files with an extension: an extensionless path would be read as a client route and answer the gateway's index.html.
    if (web && req.method === "GET" && pathname.startsWith("/static/") && extname(pathname)) return serveStatic(res, web, pathname);
    return json(res, 404, { error: "Not found" });
  }

  return createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    route(req, res).catch(error => sendFailure(res, error));
  });
}
