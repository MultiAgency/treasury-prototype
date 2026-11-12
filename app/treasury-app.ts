import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { appClient, appDaoConsentRequest, appDaoOrderRequest, parseConsentMessage, limitOrderCreateInput, limitOrderQuoteInput, limitOrderRef, limitOrderText, proposalCreateInput, proposalText, type AppBase, type AppConsentSubmission, type OwnerFailure, type LimitOrderView, type ProposalView } from "@multiagency/treasury-app-sdk";
import type { z } from "zod";
import { writeDurable } from "./durable.js";

/**
 * The Treasury app's relay to the platform's `/apps/v1` (coordination/treasury-app-move.md). It decides nothing about
 * money: the platform enforces the owner's consent, signed terms, policy, grant and strategy. What it keeps is its own
 * record of each request, written before the platform sees it, so a lost answer is resent with the same body and
 * never as a new request.
 */
export type ProposalRequest = z.input<typeof proposalCreateInput>;
export type LimitOrderRequest = z.input<typeof limitOrderCreateInput>;
export type LimitOrderQuote = z.input<typeof limitOrderQuoteInput>;
export type OrderAnswer = { ok: true; value: LimitOrderView } | OwnerFailure;
/** The reads an outside agent may make through the app (consent scope `read`, or `treasury` for the strategy). */
export type Read = "overview" | "activity" | "unresolved" | "strategy/get";
export type Signed = { message: string; nonce: string; publicKey: string; signature: string };
type Answer = { ok: true; value: ProposalView } | OwnerFailure | { ok: false; kind: "refused"; error: string; code: string };

/** Exit codes, as agentic-treasury's (src/outcome.ts): 0 ok, 2 nothing sent, 3 unknown (never resend), 4 partial. */
export const EXIT = { ok: 0, notSent: 2, unknown: 3, partial: 4 } as const;

/** A sent operation: anything the provider didn't refuse may have moved funds. */
const sent = (view: ProposalView) => view.operations.some(op => op.refused === null);

/** What an execution's answer means for the caller. A lost answer stays unknown until a read says otherwise. */
export function executionExit(answer: Answer): number {
  if (!answer.ok) return answer.kind === "unknown" ? EXIT.unknown : EXIT.notSent;
  const { state } = answer.value;
  if (state === "executed") return EXIT.ok;
  if (state === "unknown" || state === "executing") return EXIT.unknown;
  if (state === "stopped") return sent(answer.value) ? EXIT.partial : EXIT.notSent;
  return EXIT.notSent;
}

/** Any other command: an answer is 0, a lost write is 3, every other failure 2. */
export const commandExit = (answer: { ok: boolean; kind?: string }) => answer.ok ? EXIT.ok : answer.kind === "unknown" ? EXIT.unknown : EXIT.notSent;

const local = (code: string, error: string) => ({ ok: false as const, kind: "refused" as const, code, error });

/** Request records this app keeps at most; past it, new proposals are refused until old records are archived. */
export const MAX_REQUESTS = 10_000;
/** A request's record file: the platform scopes a requestId per app caller (Organization) and agent, and so does this app. */
export const requestFile = (organization: string, agent: string, requestId: string) =>
  `${createHash("sha256").update(`${organization}\n${agent}\n${requestId}`).digest("hex")}.json`;

/** How long one platform call may take before it counts as unanswered. */
export const PLATFORM_TIMEOUT_MS = 60_000;

// Coalesce explicit continuation requests across relay instances in this process. The platform's money lock and
// durable submission proof remain authoritative across processes and restarts; this map never supplies that proof.
const cancellationContinuations = new Map<string, Promise<OrderAnswer>>();

export function treasuryApp({ platform, credential, state, fetch = globalThis.fetch, maxRequests = MAX_REQUESTS, timeoutMs = PLATFORM_TIMEOUT_MS }:
  { platform: AppBase; credential: string; state: string; fetch?: typeof globalThis.fetch; maxRequests?: number; timeoutMs?: number }) {
  // No answer within the limit is no answer: the SDK then reads a write as unknown and a read as unavailable.
  const bounded: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const app = appClient({ base: platform, credential, fetch: bounded });
  const requests = join(state, "requests");
  mkdirSync(requests, { recursive: true, mode: 0o700 });

  const orderRequests = join(state, "order-requests"), orderClaims = join(state, "order-attempts"), daoVotes = join(state, "order-dao-votes"), daoConsents = join(state, "order-dao-consents");
  for (const directory of [orderRequests, orderClaims, daoVotes, daoConsents]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const claimFile = (organization: string, agent: string, id: string, action: "place" | "cancel") =>
    join(orderClaims, `${action}-${requestFile(organization, agent, id)}`);
  // An exclusive file is also the inter-process claim. A torn file remains a claim: missing JSON never permits replay.
  function exclusive(directory: string, file: string, record: unknown): boolean {
    let fd: number;
    try { fd = openSync(file, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    try { writeSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(directory, "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return true;
  }
  const uncertain = (answer: { ok: boolean; kind?: string }) => !answer.ok && (answer.kind === "unknown" || answer.kind === "unavailable");
  const unknownOrder = (id: string, action: "place" | "cancel"): OwnerFailure =>
    ({ ok: false, kind: "unknown", procedure: action === "place" ? "limitOrders/place" : "limitOrders/cancel", identity: { id } });
  async function followOrder(organization: string, agent: string, id: string, action: "place" | "cancel"): Promise<OrderAnswer> {
    const calls = app.agent(organization, agent);
    // get follows the saved proposal; refresh obtains live fills/payouts. Neither can submit a replacement.
    await calls.call("limitOrders/get", { id });
    const latest = await calls.call("limitOrders/refresh", { id });
    if (!latest.ok) return unknownOrder(id, action);
    // A read made before the platform claimed placement, or before it recorded cancellation, is not a refusal.
    if (action === "place" && ["proposed", "approved"].includes(latest.value.state)) return unknownOrder(id, action);
    if (action === "cancel" && latest.value.cancelRequestedAt === null && !["completed", "payout_failed"].includes(latest.value.state))
      return unknownOrder(id, action);
    return latest;
  }

  const daoOrderRequest = (organization: string, agent: string, hash: string): z.output<typeof appDaoOrderRequest> | null => {
    try {
      const saved = appDaoOrderRequest.parse(JSON.parse(readFileSync(join(daoVotes, requestFile(organization, agent, hash)), "utf8")));
      return saved.organization === organization && saved.agent === agent && saved.id === hash ? saved : null;
    } catch { return null; }
  };

  const daoOrderConsentRequest = (organization: string, agent: string, hash: string): z.output<typeof appDaoConsentRequest> | null => {
    try {
      const saved = appDaoConsentRequest.parse(JSON.parse(readFileSync(join(daoConsents, requestFile(organization, agent, hash)), "utf8")));
      return saved.organization === organization && saved.agent === agent && saved.id === hash ? saved : null;
    } catch { return null; }
  };

  return {
    daoOrderRequest,
    daoOrderConsentRequest,
    /** The SDK's authenticated app capabilities read grants no consent or provider order support. */
    discovery: () => app.capabilities(),
    /** File only canonical order consent. Its returned binding is durable before any member sees the transaction. */
    async daoOrderConsentFile(message: string) {
      const consent = parseConsentMessage(message);
      if (!consent || JSON.stringify([...consent.scopes].sort()) !== JSON.stringify(["read", "treasury", "treasury-orders"]))
        return local("invalid_consent", "Give the SDK's exact consent for read, treasury and treasury-orders.");
      const filed = await app.daoConsents.file(message);
      if (filed.ok) {
        const request = filed.value.request;
        if (request.organization !== consent.organization || request.agent !== consent.agent || request.agentId !== consent.agentId
          || request.dao !== consent.owner || request.expiresAt !== Date.parse(consent.expiresAt)
          || JSON.stringify([...request.scopes].sort()) !== JSON.stringify([...consent.scopes].sort()))
          return local("dao_request_mismatch", "The platform answered different DAO consent terms. No transaction was offered.");
        writeDurable(join(daoConsents, requestFile(request.organization, request.agent, request.id)), JSON.stringify(request));
      }
      return filed;
    },
    async daoOrderConsentState(organization: string, agent: string, hash: string) {
      const saved = daoOrderConsentRequest(organization, agent, hash);
      if (!saved) return local("dao_request_not_found", "No DAO order consent filed here matches this request. Nothing was relayed.");
      const result = await app.daoConsents.state(hash);
      if (result.ok) {
        if (result.value.state === "pending") {
          const request = result.value.request;
          if ((["id", "dao", "organization", "agent", "agentId", "hash", "expiresAt"] as const).some(key => request[key] !== saved[key])
            || JSON.stringify([...request.scopes].sort()) !== JSON.stringify([...saved.scopes].sort()))
            return local("dao_request_mismatch", "The platform answered a different DAO consent vote.");
        } else {
          const consent = result.value.consent;
          if (consent.organization !== organization || consent.agent !== agent || consent.agentId !== saved.agentId || consent.owner !== saved.dao
            || consent.signer !== "dao" || consent.expiresAt !== saved.expiresAt
            || JSON.stringify([...consent.scopes].sort()) !== JSON.stringify([...saved.scopes].sort()))
            return local("dao_request_mismatch", "The platform answered a different signed DAO consent.");
        }
      }
      return result;
    },
    /** Dry preview only. The platform proves exact spend, warnings and all spending authority. */
    async orderQuote(organization: string, agent: string, input: LimitOrderQuote) {
      const parsed = limitOrderQuoteInput.safeParse(input);
      if (!parsed.success) return local("invalid_request", parsed.error.issues.map(issue => issue.message).join("; "));
      return app.agent(organization, agent).call("limitOrders/quote", parsed.data);
    },
    /** Persist the request and exact terms before create; retain even a refusal so an old retry can never change terms. */
    async orderCreate(organization: string, agent: string, input: LimitOrderRequest): Promise<OrderAnswer> {
      if (!input || typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId))
        return local("invalid_request", "Give a valid order requestId.");
      const file = join(orderRequests, requestFile(organization, agent, input.requestId));
      // Validation's future-deadline rule applies to fresh requests. A saved request is immutable even after its deadline;
      // retry it as saved and let the platform answer its state. Never rebuild timestamps to pass validation.
      if (!existsSync(file)) {
        const parsed = limitOrderCreateInput.safeParse(input);
        if (!parsed.success) return local("invalid_request", parsed.error.issues.map(issue => issue.message).join("; "));
        if (readdirSync(orderRequests).filter(name => name.endsWith(".json")).length >= maxRequests)
          return local("too_many_requests", "Archive old order requests before creating another order. Nothing was sent.");
        exclusive(orderRequests, file, { organization, agent, request: parsed.data });
      }
      let saved: { organization: string; agent: string; request: LimitOrderRequest };
      try { saved = JSON.parse(readFileSync(file, "utf8")) as typeof saved; }
      catch { return local("state_review_required", "The saved order request is unreadable. Review retained state; nothing was sent."); }
      if (!saved || typeof saved !== "object" || !saved.request || typeof saved.request !== "object" || Array.isArray(saved.request))
        return local("state_review_required", "The saved order request is malformed. Review retained state; nothing was sent.");
      const ordered = (request: LimitOrderRequest) => JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))));
      if (saved.organization !== organization || saved.agent !== agent || ordered(saved.request) !== ordered(input))
        return local("request_conflict", "This order requestId has different saved terms. Nothing was sent.");
      const calls = app.agent(organization, agent), made = await calls.call("limitOrders/create", saved.request);
      return uncertain(made) ? calls.call("limitOrders/create", saved.request) : made;
    },
    orderGet: (organization: string, agent: string, id: string) => app.agent(organization, agent).call("limitOrders/get", { id }),
    orderList: (organization: string, agent: string) => app.agent(organization, agent).call("limitOrders/list"),
    orderRefresh: (organization: string, agent: string, id: string) => app.agent(organization, agent).call("limitOrders/refresh", { id }),
    orderAttempted: (organization: string, agent: string, id: string) => ({
      place: existsSync(claimFile(organization, agent, id, "place")), cancel: existsSync(claimFile(organization, agent, id, "cancel")),
    }),
    /** Only the current saved order's SDK text may reach approve/reject. These calls send no funds. */
    async orderDecide(organization: string, agent: string, id: string, verdict: "approve" | "reject", signed: Signed): Promise<OrderAnswer> {
      const calls = app.agent(organization, agent), current = await calls.call("limitOrders/get", { id });
      if (!current.ok) return current;
      if (signed.message !== limitOrderText(current.value, verdict))
        return local("signature_text_mismatch", "The signature is not over this order's exact terms. Nothing was relayed.");
      return calls.call(verdict === "approve" ? "limitOrders/approve" : "limitOrders/reject", { id, signed });
    },
    /** One durable claim before one placement call, including concurrent HTTP requests and app restarts. */
    async orderPlace(organization: string, agent: string, id: string): Promise<OrderAnswer> {
      if (!limitOrderRef.safeParse({ id }).success) return local("invalid_request", "Give a valid order ID.");
      if (!exclusive(orderClaims, claimFile(organization, agent, id, "place"), { organization, agent, id, action: "place", at: new Date().toISOString() }))
        return followOrder(organization, agent, id, "place");
      const placed = await app.agent(organization, agent).call("limitOrders/place", { id });
      return uncertain(placed) ? followOrder(organization, agent, id, "place") : placed;
    },
    /** Initial cancellation is one attempt. Repeated initial requests only read, even when a continuation is possible. */
    async orderCancel(organization: string, agent: string, id: string): Promise<OrderAnswer> {
      if (!limitOrderRef.safeParse({ id }).success) return local("invalid_request", "Give a valid order ID.");
      if (!exclusive(orderClaims, claimFile(organization, agent, id, "cancel"), { organization, agent, id, action: "cancel", at: new Date().toISOString() }))
        return followOrder(organization, agent, id, "cancel");
      const canceled = await app.agent(organization, agent).call("limitOrders/cancel", { id });
      return uncertain(canceled) ? followOrder(organization, agent, id, "cancel") : canceled;
    },
    /** Only an explicit continuation with fresh platform proof may finish the same pre-submission cancellation. */
    async orderContinueCancel(organization: string, agent: string, id: string): Promise<OrderAnswer> {
      if (!limitOrderRef.safeParse({ id }).success) return local("invalid_request", "Give a valid order ID.");
      const key = JSON.stringify([resolve(state), platform, organization, agent, id]);
      const pending = cancellationContinuations.get(key);
      if (pending) return pending;
      // Deferring work until the next microtask installs the coalescing entry before any SDK call can begin.
      const continuing = Promise.resolve().then(async (): Promise<OrderAnswer> => {
        const calls = app.agent(organization, agent);
        const saved = await calls.call("limitOrders/get", { id });
        if (!saved.ok) return saved;
        if (saved.value.id !== id) return local("order_identity_mismatch", "The platform returned another order. Nothing was canceled.");
        const current = await calls.call("limitOrders/refresh", { id });
        if (!current.ok) return current;
        if (current.value.id !== id) return local("order_identity_mismatch", "The platform refreshed another order. Nothing was canceled.");
        if (current.value.cancelMayResume !== true)
          return local("cancel_not_resumable", "The platform has not proved this cancellation is still before submission. Follow this order with reads only.");
        // Retain any existing claim, including a torn one. A positive platform proof never resets local attempts.
        exclusive(orderClaims, claimFile(organization, agent, id, "cancel"), { organization, agent, id, action: "cancel", at: new Date().toISOString() });
        const canceled = await calls.call("limitOrders/cancel", { id });
        // No automatic continuation after a lost reply. Another explicit action must obtain fresh proof again.
        return uncertain(canceled) ? followOrder(organization, agent, id, "cancel") : canceled;
      });
      cancellationContinuations.set(key, continuing);
      try { return await continuing; }
      finally { if (cancellationContinuations.get(key) === continuing) cancellationContinuations.delete(key); }
    },
    /** The platform constructs the DAO transaction; the app records its binding before showing it to a member. */
    async daoOrderFile(organization: string, agent: string, id: string, verdict: "approve" | "reject") {
      const filed = await app.daoLimitOrders.file({ organization, agent, order: id, verdict });
      if (filed.ok) {
        const request = filed.value.request;
        if (request.organization !== organization || request.agent !== agent || request.order !== id || request.verdict !== verdict)
          return local("dao_request_mismatch", "The platform answered a DAO request for different order terms. No transaction was offered.");
        writeDurable(join(daoVotes, requestFile(organization, agent, request.id)), JSON.stringify(request));
      }
      return filed;
    },
    /** Polling can relay a DAO signature: check the saved binding before calling the platform, never afterwards. */
    async daoOrderState(organization: string, agent: string, id: string, hash: string) {
      const saved = daoOrderRequest(organization, agent, hash);
      if (!saved) return local("dao_request_not_found", "No DAO vote filed here matches this order. Nothing was relayed.");
      if (saved.order !== id)
        return local("dao_request_mismatch", "The DAO vote belongs to another order. Nothing was relayed.");
      const result = await app.daoLimitOrders.state(hash);
      if (result.ok && (["id", "dao", "organization", "agent", "agentId", "order", "verdict", "hash"] as const)
        .some(key => result.value.request[key] !== saved[key]))
        return local("dao_request_mismatch", "The platform answered a different DAO vote. Do not treat its signature as this order's approval.");
      return result;
    },
    /**
     * Proposes swaps once per `requestId` for this Organization and agent. The request is recorded before the call; the
     * same `requestId` with other terms is refused here, as the platform would. After a lost answer the identical body
     * is sent once more, which the platform answers with the stored proposal. A request the platform plainly refused
     * stored nothing there, so its new record is dropped and the agent may correct it under the same `requestId`.
     */
    async propose(organization: string, agent: string, input: ProposalRequest): Promise<Answer> {
      const parsed = proposalCreateInput.safeParse(input);
      if (!parsed.success) return local("invalid_request", parsed.error.issues.map(issue => issue.message).join("; "));
      const request = parsed.data, file = join(requests, requestFile(organization, agent, request.requestId));
      const record = { organization, agent, request }, fresh = !existsSync(file);
      if (!fresh) {
        if (JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !== JSON.stringify(record))
          return local("request_conflict", "This requestId was used for other terms. Nothing was sent; use a new requestId.");
      } else {
        if (readdirSync(requests).filter(name => name.endsWith(".json")).length >= maxRequests)
          return local("too_many_requests", "This app holds too many request records. Nothing was sent; the operator archives old ones.");
        writeDurable(file, JSON.stringify(record));
      }
      // Both calls send the request as saved, never rebuilt: the platform compares the terms as exact JSON, so a
      // reformatted `expiresAt` would be another request (dao/sdk@1a7fe98 src/proposals/service.ts:99).
      const saved = (JSON.parse(readFileSync(file, "utf8")) as typeof record).request;
      const calls = app.agent(organization, agent);
      const lost = (answer: Answer) => !answer.ok && (answer.kind === "unknown" || answer.kind === "unavailable");
      const made = await calls.call("proposals/create", saved);
      const answer = made.ok || !lost(made) ? made : await calls.call("proposals/create", saved);
      if (fresh && !answer.ok && !lost(answer)) rmSync(file, { force: true });
      return answer;
    },

    /** The agent's owner and provider ID now, as the platform answers them. */
    identity: (agent: string) => app.identity(agent),
    /** The app's consents for an Organization, as the platform holds them now. */
    consents: (organization: string) => app.consents.list(organization),
    /**
     * The owner's signed consent, submitted once; with no answer, the same signed body once more, which the platform
     * treats as the same consent (SDK app-server skill: "the same signed body is safe to submit again").
     */
    async submitConsent(submission: AppConsentSubmission) {
      const stored = await app.consents.submit(submission);
      return !stored.ok && stored.kind === "unavailable" ? app.consents.submit(submission) : stored;
    },
    /** Permanent: the owner signs a new consent to restore access. */
    revokeConsent: (id: string) => app.consents.revoke(id),
    /** One of the reads an agent's token may make. */
    read: (organization: string, agent: string, path: Read) => app.agent(organization, agent).call(path),

    get: (organization: string, agent: string, id: string) => app.agent(organization, agent).call("proposals/get", { id }),
    list: (organization: string, agent: string) => app.agent(organization, agent).call("proposals/list"),
    withdraw: (organization: string, agent: string, id: string) => app.agent(organization, agent).call("proposals/withdraw", { id }),

    /**
     * Relays the owner's signature only over the exact text the platform builds from the proposal it holds now; any
     * other text is refused here without a call. Approving sends nothing.
     */
    async decide(organization: string, agent: string, id: string, verdict: "approve" | "reject", signed: Signed): Promise<Answer> {
      const calls = app.agent(organization, agent);
      const current = await calls.call("proposals/get", { id });
      if (!current.ok) return current;
      if (signed.message !== proposalText(current.value, verdict))
        return local("signature_text_mismatch", "The signed text is not this proposal's exact terms. Nothing was relayed.");
      const decided = await calls.call(verdict === "approve" ? "proposals/approve" : "proposals/reject", { id, signed });
      // The platform's own signature check answers a plain 400 before the agent sees anything ("Nothing was recorded",
      // dao/sdk@1a7fe98 src/gateway/app-routes.ts:179-180); the SDK can't read it as a refusal, so it says unknown.
      if (!decided.ok && decided.kind === "unknown" && (decided as { httpStatus?: number }).httpStatus === 400)
        return local("signature_refused", "The platform refused this signature: sign with the agent owner's full-access key. Nothing was recorded.");
      return decided;
    },

    /**
     * One execution attempt. A lost answer is read back, never retried: the swaps may have run. A read-back that still
     * says `approved` proves nothing either: the platform re-quotes before it claims the proposal (dao/sdk@1a7fe98
     * src/proposals/service.ts:214, claim at :233), so the attempt may still be running. It stays unknown.
     */
    async execute(organization: string, agent: string, id: string): Promise<Answer> {
      const calls = app.agent(organization, agent);
      const ran = await calls.call("proposals/execute", { id });
      if (ran.ok || (ran.kind !== "unknown" && ran.kind !== "unavailable")) return ran;
      const read = await calls.call("proposals/get", { id });
      return read.ok && read.value.state !== "approved" ? read : ran.kind === "unknown" ? ran
        : { ok: false, kind: "unknown", procedure: "proposals/execute", identity: { id } } as Answer;
    },
  };
}
export type TreasuryApp = ReturnType<typeof treasuryApp>;
