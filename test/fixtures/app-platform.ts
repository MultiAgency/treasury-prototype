import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach } from "node:test";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { appConsentSubmission, proposalCreateInput, proposalRef, proposalSigned, type ProposalView } from "@multiagency/sdk";
import { RuntimeTokens } from "../../app/runtime-tokens.js";
import { createAppServer } from "../../app/server.js";
import { treasuryApp } from "../../app/treasury-app.js";
import { sessionToken } from "../../shared/signin.js";

/**
 * The Treasury app's server, on loopback, in front of a fixture platform: identity, consents and Treasury procedures,
 * answered through the SDK's schemas and oRPC's encoder. No wallet, credential, signature or funds. Each test starts
 * from the same world; tests change it to describe what the platform answers.
 */
export const HOST = "treasury-app.test", PLATFORM_HOST = "platform.example", SECRET = "s".repeat(32);
export const OWNER = "owner.near", ORG = "org_1", AGENT = "portfolio", ID = "7d3c1f0e2b4a4c5d8e6f1a2b3c4d5e6f";
export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", WNEAR = "nep141:wrap.near";

const initial = () => ({
  owner: OWNER, agentId: "agent-1", scopes: ["read", "treasury"], revoked: false, expiresAt: Date.now() + 86_400_000, down: false,
  /** The agent's new owner, or its new identity, has also consented to the app. */
  consentFollows: false,
  /** The proposal's state as `proposals/get` answers it, and what `proposals/execute` answers (or loses). */
  proposalState: "proposed" as ProposalView["state"], execute: "executed" as ProposalView["state"] | "lose" | "not_executable",
  proposalDecision: "normal" as "normal" | "lose" | "plain-400" | "refuse",
  proposalDecisionGate: null as Promise<void> | null,
  proposalDecisionReadGate: null as Promise<void> | null,
  /** Whether the agent exists yet, and how many consent submissions go unanswered before one is answered. */
  created: true, loseSubmissions: 0,
  /** A refusal code the platform answers to `proposals/create`, if any. */
  refuseCreate: null as string | null,
});

export function appPlatform(name: string) {
  const world = initial();
  const calls: { path: string; input: unknown }[] = [];
  /** What the platform received on its app routes: consent submissions (after the SDK's schema) and revocations. */
  const submissions: unknown[] = [], revocations: string[] = [];
  const reached: string[] = [];
  beforeEach(() => { Object.assign(world, initial()); calls.length = 0; reached.length = 0; submissions.length = 0; revocations.length = 0;
    for (const file of readdirSync(join(state, "decision-attempts"))) rmSync(join(state, "decision-attempts", file), { recursive: true });
  });

  const view = (state: ProposalView["state"]): ProposalView => ({ id: ID, requestId: "req-1", agentId: world.agentId, deployment: "treasury-app",
    organization: ORG, source: "external", legs: [{ from: USDC, to: WNEAR, amount: "1000000", minAmountOut: "490000000000000000000000" }],
    quoted: [{ amountOut: "500000000000000000000000", costBps: 5, usdIn: 1 }], policyRevision: 3, policyDigest: "a".repeat(64),
    strategyDigest: `sha256:${"b".repeat(64)}`, createdAt: "2026-11-03T00:00:00.000Z", expiresAt: "2026-11-05T00:00:00.000Z", note: null,
    sha256: "c".repeat(64), state, reason: null, approvedAt: null, planId: null, operations: [] });
  // Inputs pass the platform's own schemas, so a malformed request fails here as it would on the platform.
  const schemas: Record<string, { parse: (input: unknown) => unknown }> = { "proposals/create": proposalCreateInput, "proposals/get": proposalRef,
    "proposals/withdraw": proposalRef, "proposals/execute": proposalRef, "proposals/approve": proposalSigned, "proposals/reject": proposalSigned };
  const recorded = <T>(path: string, answer: (input: unknown) => T) => os.handler(({ input }) => {
    const checked = schemas[path] ? schemas[path]!.parse(input) : input;
    reached.push(path); calls.push({ path, input: checked }); return answer(checked);
  });
  const rpc = new RPCHandler({
    unresolved: recorded("unresolved", () => []),
    activity: recorded("activity", () => []),
    proposals: {
      create: recorded("proposals/create", () => {
        if (world.refuseCreate) throw new ORPCError("BAD_REQUEST", { message: "a leg's floor is above the quote", data: { kind: "refused", code: world.refuseCreate } });
        return view("proposed");
      }),
      get: recorded("proposals/get", async () => {
        const gate = world.proposalDecisionReadGate; world.proposalDecisionReadGate = null;
        await gate; return view(world.proposalState);
      }),
      list: recorded("proposals/list", () => ({ proposals: [view(world.proposalState)] })),
      withdraw: recorded("proposals/withdraw", () => view("withdrawn")),
      approve: recorded("proposals/approve", async () => {
        await world.proposalDecisionGate;
        if (world.proposalDecision === "refuse") throw new ORPCError("BAD_REQUEST", { message: "Signature refused", data: { kind: "refused", code: "signature_refused" } });
        world.proposalState = "approved"; return view("approved");
      }),
      reject: recorded("proposals/reject", async () => {
        await world.proposalDecisionGate;
        if (world.proposalDecision === "refuse") throw new ORPCError("BAD_REQUEST", { message: "Signature refused", data: { kind: "refused", code: "signature_refused" } });
        world.proposalState = "rejected"; return view("rejected");
      }),
      execute: recorded("proposals/execute", () => {
        if (world.execute === "not_executable") throw new ORPCError("BAD_REQUEST", { message: "below the signed floor", data: { kind: "refused", code: "not_executable" } });
        return view(world.execute === "lose" ? "executed" : world.execute);
      }),
    },
    executePlan: recorded("executePlan", () => []),
  });
  async function fetch(input: RequestInfo | URL, init?: RequestInit) {
    if (world.down) return new Response(null, { status: 503 });
    const req = new Request(input, init), url = new URL(req.url);
    if (url.pathname === `/apps/v1/agents/${AGENT}`)
      return Response.json({ agent: AGENT, owner: world.owner, agentId: world.created ? world.agentId : null, created: world.created, host: PLATFORM_HOST, deployment: "treasury-app" });
    if (url.pathname === "/apps/v1/consents" && req.method === "POST") {
      submissions.push(appConsentSubmission.parse(await req.json()));
      if (world.loseSubmissions > 0) { world.loseSubmissions--; return new Response(null, { status: 503 }); }
      return Response.json({ consent: { id: "e".repeat(64), deployment: "treasury-app", host: PLATFORM_HOST, organization: ORG, owner: world.owner, agent: AGENT,
        agentId: world.agentId, scopes: ["read", "treasury"], expiresAt: Date.now() + 86_400_000, createdAt: Date.now(), publicKey: "ed25519:11111111111111111111111111111111",
        revoked: false, revokedAt: null } }, { status: 201 });
    }
    const revoke = url.pathname.match(/^\/apps\/v1\/consents\/([a-f0-9]{64})$/);
    if (revoke && req.method === "DELETE") { revocations.push(revoke[1]!); return Response.json({ revoked: true }); }
    if (url.pathname === "/apps/v1/consents")
      // A consent belongs to its own Organization: the app must filter, whatever the query asked for.
      return Response.json({ consents: [{ id: "d".repeat(64), deployment: "treasury-app", host: PLATFORM_HOST, organization: ORG,
        owner: world.consentFollows ? world.owner : OWNER, agent: AGENT, agentId: world.consentFollows ? world.agentId : "agent-1",
        scopes: world.scopes, expiresAt: world.expiresAt, createdAt: Date.now() - 1_000, publicKey: "ed25519:fixture", revoked: world.revoked, revokedAt: null }] });
    const { matched, response } = await rpc.handle(req, { prefix: `/apps/v1/o/${ORG}/a/${AGENT}/rpc` });
    if (!matched) return new Response(null, { status: 404 });
    const decisionProcedure = url.pathname.split("/rpc/")[1];
    if (decisionProcedure === "proposals/approve" || decisionProcedure === "proposals/reject") {
      if (world.proposalDecision === "lose") return new Response(null, { status: 502 });
      if (world.proposalDecision === "plain-400") return Response.json({ error: "Reply after decision was recorded" }, { status: 400 });
    }
    // A lost answer: the platform acted, the reply never arrived.
    return world.execute === "lose" && reached.at(-1) === "proposals/execute" ? new Response(null, { status: 502 }) : response;
  }

  const state = mkdtempSync(join(tmpdir(), `${name}-`));
  const tokens = new RuntimeTokens(join(state, "tokens"));
  const platform = treasuryApp({ platform: `https://${PLATFORM_HOST}`, credential: "tap_fixture", state, fetch: fetch as typeof globalThis.fetch });
  const server = createAppServer({ host: HOST, secret: SECRET, keyLookup: async () => "FullAccess", platform, tokens, secure: false });
  let port = 0;
  before(() => new Promise<void>(done => server.listen(0, "127.0.0.1", () => { port = (server.address() as AddressInfo).port; done(); })));
  after(() => new Promise<void>(done => server.close(() => done())));

  /** Raw HTTP, so the Host header is exactly as sent. */
  function call(path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
    return new Promise<{ status: number; body: any }>((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers: { host: HOST, ...(body !== undefined && { "content-type": "application/json" }), ...headers } }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk)).on("end", () => done({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || "null") }));
      });
      req.on("error", fail); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  /** A signed-in session for `account` (sign-in itself is covered by test/app-server.test.ts). */
  const as = (account: string) => ({ cookie: `treasury_app_session=${sessionToken(account, SECRET)}` });
  return { world, calls, reached, submissions, revocations, view, state, tokens, call, as, port: () => port };
}
