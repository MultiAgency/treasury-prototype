import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appClient, proposalCreateInput, proposalText, type AppBase, type AppConsentSubmission, type OwnerFailure, type ProposalView } from "@multiagency/sdk";
import type { z } from "zod";
import { writeDurable } from "./durable.js";

/**
 * The Treasury app's relay to the platform's `/apps/v1` (coordination/treasury-app-move.md). It decides nothing about
 * money: the platform enforces the owner's consent, signed terms, policy, grant and strategy. What it keeps is its own
 * record of each request, written before the platform sees it, so a lost answer is resent with the same body and
 * never as a new request.
 */
export type ProposalRequest = z.input<typeof proposalCreateInput>;
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

export function treasuryApp({ platform, credential, state, fetch = globalThis.fetch, maxRequests = MAX_REQUESTS, timeoutMs = PLATFORM_TIMEOUT_MS }:
  { platform: AppBase; credential: string; state: string; fetch?: typeof globalThis.fetch; maxRequests?: number; timeoutMs?: number }) {
  // No answer within the limit is no answer: the SDK then reads a write as unknown and a read as unavailable.
  const bounded: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const app = appClient({ base: platform, credential, fetch: bounded });
  const requests = join(state, "requests");
  mkdirSync(requests, { recursive: true, mode: 0o700 });

  // An exclusive directory survives a crash even if its record is torn. Only the handler that created it may
  // archive a proven refusal; reads and restarts never erase attempts or infer safety from a proposed view.
  const decisions = join(state, "decision-attempts");
  mkdirSync(decisions, { recursive: true, mode: 0o700 });
  const syncDirectory = (directory: string) => { const fd = openSync(directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
  syncDirectory(state);
  const decisionOrigin = new URL(platform).origin;
  const decisionScope = (domain: "proposal" | "order", organization: string, agent: string, id: string) =>
    createHash("sha256").update(JSON.stringify([decisionOrigin, domain, organization, agent, id])).digest("hex");
  const decisionPath = (domain: "proposal" | "order", organization: string, agent: string, id: string) =>
    join(decisions, `${decisionScope(domain, organization, agent, id)}.active`);
  const provenRefusal = (kind?: string) => ["refused", "session", "forbidden", "unresolved", "busy", "rate_limited"].includes(kind ?? "");
  function refusedDecisions(domain: "proposal" | "order", organization: string, agent: string, id: string) {
    const prefix = `${decisionScope(domain, organization, agent, id)}.refused.`;
    return readdirSync(decisions).filter(name => name.startsWith(prefix)).map(name => {
      const attempt = JSON.parse(readFileSync(join(decisions, name, "attempt.json"), "utf8")) as Record<string, unknown>;
      const refusal = JSON.parse(readFileSync(join(decisions, name, "refusal.json"), "utf8")) as Record<string, unknown>;
      if (attempt.version !== 1 || attempt.platform !== decisionOrigin || attempt.domain !== domain || attempt.organization !== organization
        || attempt.agent !== agent || attempt.id !== id || typeof attempt.attemptId !== "string" || name !== prefix + attempt.attemptId
        || typeof attempt.signedBodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(attempt.signedBodySha256)
        || refusal.version !== 1 || refusal.attemptId !== attempt.attemptId || typeof refusal.kind !== "string" || !provenRefusal(refusal.kind))
        throw new Error("The retained decision refusal needs review.");
      return attempt;
    });
  }
  function decisionHeld(domain: "proposal" | "order", organization: string, agent: string, id: string) {
    try { lstatSync(decisionPath(domain, organization, agent, id)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
    try { refusedDecisions(domain, organization, agent, id); return false; } catch { return true; }
  }
  const decisionUnknown = (domain: "proposal" | "order", id: string, verdict: "approve" | "reject"): OwnerFailure =>
    ({ ok: false, kind: "unknown", procedure: verdict === "approve" ? "proposals/approve" : "proposals/reject", identity: { id } });
  async function relayDecision<T extends { ok: boolean; kind?: string }>(domain: "proposal" | "order", organization: string, agent: string,
    id: string, verdict: "approve" | "reject", signed: Signed, send: () => Promise<T>): Promise<T | OwnerFailure> {
    const active = decisionPath(domain, organization, agent, id), attemptId = randomUUID();
    const signedBodySha256 = createHash("sha256").update(JSON.stringify({ message: signed.message, nonce: signed.nonce, publicKey: signed.publicKey, signature: signed.signature })).digest("hex");
    const unknown = decisionUnknown(domain, id, verdict);
    try { mkdirSync(active, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return unknown; throw error; }
    // Persist the name first, then the exact signed-body identity, before any relay can reach the platform.
    syncDirectory(decisions);
    writeDurable(join(active, "attempt.json"), JSON.stringify({ version: 1, platform: decisionOrigin, domain, organization, agent, id, verdict, attemptId,
      signedBodySha256, at: new Date().toISOString() }));
    // Re-read under the exclusive claim: another request could have finished a refusal while this one was
    // validating its text. Even a refused signature body is never relayed a second time after restart.
    const replayed = refusedDecisions(domain, organization, agent, id).some(attempt => attempt.signedBodySha256 === signedBodySha256);
    const answer = replayed ? local("decision_already_attempted", "This exact signed decision was already attempted. Follow its existing outcome; a proven refusal permits only a new explicit signature.") : await send();
    if (!answer.ok && provenRefusal(answer.kind)) {
      // A plain HTTP status, provider failure or unreadable response is never this proof. The SDK's typed
      // before-effect refusal permits a new explicit decision; keep its evidence in a unique immutable archive.
      writeDurable(join(active, "refusal.json"), JSON.stringify({ version: 1, attemptId, kind: answer.kind, at: new Date().toISOString() }));
      renameSync(active, `${active.slice(0, -".active".length)}.refused.${attemptId}`);
      syncDirectory(decisions);
    }
    // Once admitted, any unresolved call remains an unknown decision attempt for direct callers too.
    return !answer.ok && !provenRefusal(answer.kind) ? unknown : answer;
  }

  return {
    decisionHeld,
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
      if (decisionHeld("proposal", organization, agent, id)) return decisionUnknown("proposal", id, verdict);
      const calls = app.agent(organization, agent);
      return relayDecision("proposal", organization, agent, id, verdict, signed, async () => {
        const current = await calls.call("proposals/get", { id });
        if (!current.ok) return current;
        if (signed.message !== proposalText(current.value, verdict))
          return local("signature_text_mismatch", "The signed text is not this proposal's exact terms. Nothing was relayed.");
        return calls.call(verdict === "approve" ? "proposals/approve" : "proposals/reject", { id, signed });
      });
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
