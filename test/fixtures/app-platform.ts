import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach } from "node:test";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { appConsentSubmission, limitOrderCreateInput, limitOrderQuoteInput, limitOrderRef, limitOrderSigned, proposalCreateInput, proposalRef, proposalSigned,
  type DaoPolicy, type LimitOrderView, type ProposalView } from "@multiagency/treasury-app-sdk";
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
export const DAO = "treasury.sputnik-dao.near", MEMBER = "member.near", READER = "reader.near", DAO_ORDER_HASH = "f".repeat(64);
export const DAO_CONSENT_HASH = "a".repeat(64);
const memberPolicy = (): DaoPolicy => ({ proposal_bond: "1", default_vote_policy: { threshold: [1, 2] }, roles: [
  { name: "council", kind: { Group: [MEMBER] }, permissions: ["call:AddProposal", "call:VoteApprove"], vote_policy: {} },
  { name: "readers", kind: { Group: [READER] }, permissions: [], vote_policy: {} },
  { name: "public", kind: "Everyone", permissions: [], vote_policy: {} },
] });

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
  orderDecision: "normal" as "normal" | "lose" | "plain-400" | "refuse",
  orderDecisionGate: null as Promise<void> | null,
  orderDecisionReadGate: null as Promise<void> | null,
  capabilities: ["treasury-limit-orders-v1"],
  capabilitiesResponse: "normal" as "normal" | "malformed" | "missing" | "unavailable" | "not_found" | "credential_refused",
  signer: "wallet" as "wallet" | "dao", daoPolicy: memberPolicy() as DaoPolicy | null,
  orderState: "proposed" as LimitOrderView["state"], placeOrder: "resting" as "resting" | "lose",
  cancelOrder: "cancel_requested" as "cancel_requested" | "lose" | "pre_submission",
  cancelMayResume: false as boolean | undefined, cancelMayResumeAfterGet: undefined as boolean | undefined,
  orderViewOverride: {} as Record<string, unknown>, orderReadFailure: "none" as "none" | "get" | "refresh" | "both",
  orderDeadline: new Date(Date.now() + 3_600_000).toISOString(), orderExpiry: new Date(Date.now() + 1_800_000).toISOString(),
  orderBody: null as Record<string, unknown> | null, loseOrderCreates: 0,
  fillStatus: null as string | null, payoutStatus: null as string | null, isPayoutStatusFinal: null as boolean | null,
  partialFills: null as unknown[] | null, payouts: null as Record<string, unknown> | null,
  daoOrderState: "pending" as "pending" | "relayed", daoRequestOverride: {} as Record<string, unknown>,
  daoConsentState: "pending" as "pending" | "signed", daoConsentMessage: "", daoConsentOverride: {} as Record<string, unknown>,
});

export function appPlatform(name: string) {
  const world = initial();
  const calls: { path: string; input: unknown }[] = [];
  /** What the platform received on its app routes: consent submissions (after the SDK's schema) and revocations. */
  const submissions: unknown[] = [], revocations: string[] = [];
  /** Simulated provider POSTs, separate from SDK cancel calls: a prepared platform claim has submitted none yet. */
  const providerCancelPosts: { id: string }[] = [];
  const reached: string[] = [];
  /** Discovery is a credentialed app route; public owner discovery is deliberately unavailable on this host. */
  const capabilityRequests: { path: string; method: string; authorization: string | null }[] = [], publicDiscoveryRequests: string[] = [];
  beforeEach(() => {
    Object.assign(world, initial()); calls.length = 0; reached.length = 0; submissions.length = 0; revocations.length = 0;
    for (const file of readdirSync(join(state, "decision-attempts"))) rmSync(join(state, "decision-attempts", file), { recursive: true });
    providerCancelPosts.length = 0;
    capabilityRequests.length = 0; publicDiscoveryRequests.length = 0;
    // Fixture isolation: remove only this simulated app's limit-order records, retaining the directories the relay opened.
    for (const directory of ["order-requests", "order-attempts", "order-dao-votes", "order-dao-consents"])
      for (const file of readdirSync(join(state, directory))) rmSync(join(state, directory, file), { recursive: true });
  });

  const view = (state: ProposalView["state"]): ProposalView => ({ id: ID, requestId: "req-1", agentId: world.agentId, deployment: "treasury-app",
    organization: ORG, source: "external", legs: [{ from: USDC, to: WNEAR, amount: "1000000", minAmountOut: "490000000000000000000000" }],
    quoted: [{ amountOut: "500000000000000000000000", costBps: 5, usdIn: 1 }], policyRevision: 3, policyDigest: "a".repeat(64),
    strategyDigest: `sha256:${"b".repeat(64)}`, createdAt: "2026-11-03T00:00:00.000Z", expiresAt: "2026-11-05T00:00:00.000Z", note: null,
    sha256: "c".repeat(64), state, reason: null, approvedAt: null, planId: null, operations: [] });
  const orderView = (state: LimitOrderView["state"] = world.orderState): LimitOrderView => ({
    id: ID, requestId: "order-1", agentId: world.agentId, deployment: "treasury-app", organization: ORG,
    order: { base_asset: WNEAR, quote_asset: USDC, side: "sell", quantity: "1000000000000000000000000", price: "2.5", deadline: world.orderDeadline, confidential: true,
      ...Object.fromEntries(Object.entries(world.orderBody ?? {}).filter(([key]) => ["base_asset", "quote_asset", "side", "quantity", "price", "deadline", "confidential"].includes(key))) },
    spendAsset: WNEAR, spendAmount: "1000000000000000000000000", outputAsset: USDC,
    policyRevision: 3, policyDigest: "a".repeat(64), strategyDigest: `sha256:${"b".repeat(64)}`,
    createdAt: "2026-11-11T00:00:00.000Z", expiresAt: world.orderExpiry, note: null, sha256: "c".repeat(64), state, reason: null,
    approvedAt: state === "proposed" ? null : "2026-11-11T00:01:00.000Z", correlationId: null,
    orderId: ["resting", "partially_filled", "cancel_requested", "completed", "payout_failed"].includes(state) ? "provider-order-1" : null,
    fillStatus: world.fillStatus, payoutStatus: world.payoutStatus, isPayoutStatusFinal: world.isPayoutStatusFinal,
    partialFills: world.partialFills, payouts: world.payouts, cancelRequestedAt: state === "cancel_requested" ? "2026-11-11T00:02:00.000Z" : null,
    ...(world.cancelMayResume === undefined ? {} : { cancelMayResume: world.cancelMayResume }), operation: null,
  });
  // Wire-only overrides intentionally exercise malformed SDK output instead of passing an invalid value through TS.
  const orderWireView = (state: LimitOrderView["state"] = world.orderState) => ({ ...orderView(state), ...world.orderViewOverride });
  const daoOrderRequest = () => ({ id: DAO_ORDER_HASH, dao: world.owner, organization: ORG, agent: AGENT, agentId: world.agentId,
    order: ID, verdict: "approve", votingUntil: Date.now() + 600_000, hash: DAO_ORDER_HASH, description: "Approve the exact order",
    ...world.daoRequestOverride });
  const daoConsentRequest = () => {
    const consent = JSON.parse(world.daoConsentMessage) as { scopes: string[]; expiresAt: string };
    return { id: DAO_CONSENT_HASH, dao: world.owner, organization: ORG, agent: AGENT, agentId: world.agentId,
      scopes: consent.scopes, expiresAt: Date.parse(consent.expiresAt), votingUntil: Date.now() + 600_000,
      hash: DAO_CONSENT_HASH, description: "Consent to exact Treasury orders", ...world.daoConsentOverride };
  };
  // Inputs pass the platform's own schemas, so a malformed request fails here as it would on the platform.
  const schemas: Record<string, { parse: (input: unknown) => unknown }> = { "proposals/create": proposalCreateInput, "proposals/get": proposalRef,
    "proposals/withdraw": proposalRef, "proposals/execute": proposalRef, "proposals/approve": proposalSigned, "proposals/reject": proposalSigned,
    "limitOrders/quote": limitOrderQuoteInput, "limitOrders/create": limitOrderCreateInput, "limitOrders/get": limitOrderRef,
    "limitOrders/list": { parse: value => value }, "limitOrders/approve": limitOrderSigned, "limitOrders/reject": limitOrderSigned,
    "limitOrders/place": limitOrderRef, "limitOrders/cancel": limitOrderRef, "limitOrders/refresh": limitOrderRef };
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
    limitOrders: {
      quote: recorded("limitOrders/quote", () => ({ order: orderView().order, spendAsset: WNEAR, spendAmount: "1000000000000000000000000", outputAsset: USDC,
        warnings: [], quote: {}, ownerApproval: null, fee: null, policyRevision: 3, policyDigest: "a".repeat(64), strategyDigest: `sha256:${"b".repeat(64)}` })),
      create: recorded("limitOrders/create", input => { world.orderBody = input as Record<string, unknown>; return orderView("proposed"); }),
      get: recorded("limitOrders/get", async () => {
        const gate = world.orderDecisionReadGate; world.orderDecisionReadGate = null; await gate;
        const answer = orderWireView();
        if (world.cancelMayResumeAfterGet !== undefined) world.cancelMayResume = world.cancelMayResumeAfterGet;
        return answer;
      }),
      list: recorded("limitOrders/list", () => ({ orders: [orderWireView()] })),
      approve: recorded("limitOrders/approve", async () => {
        await world.orderDecisionGate;
        if (world.orderDecision === "refuse") throw new ORPCError("BAD_REQUEST", { message: "Signature refused", data: { kind: "refused", code: "signature_refused" } });
        world.orderState = "approved"; return orderView("approved");
      }),
      reject: recorded("limitOrders/reject", async () => {
        await world.orderDecisionGate;
        if (world.orderDecision === "refuse") throw new ORPCError("BAD_REQUEST", { message: "Signature refused", data: { kind: "refused", code: "signature_refused" } });
        world.orderState = "rejected"; return orderView("rejected");
      }),
      place: recorded("limitOrders/place", () => orderView("resting")),
      cancel: recorded("limitOrders/cancel", input => {
        world.orderState = "cancel_requested";
        if (world.cancelOrder === "pre_submission") world.cancelMayResume = true;
        else {
          world.cancelMayResume = false;
          const id = (input as { id: string }).id;
          if (!providerCancelPosts.some(post => post.id === id)) providerCancelPosts.push({ id });
        }
        return orderWireView();
      }),
      refresh: recorded("limitOrders/refresh", () => orderWireView()),
    },
    executePlan: recorded("executePlan", () => []),
  });
  async function fetch(input: RequestInfo | URL, init?: RequestInit) {
    if (world.down) return new Response(null, { status: 503 });
    const req = new Request(input, init), url = new URL(req.url);
    if (url.pathname === "/gw/me") { publicDiscoveryRequests.push(url.pathname); return new Response(null, { status: 404 }); }
    if (url.pathname === "/apps/v1/capabilities") {
      capabilityRequests.push({ path: url.pathname, method: req.method, authorization: req.headers.get("authorization") });
      assert.equal(req.method, "GET", "host capabilities use the SDK's GET app route");
      assert.equal(req.headers.get("authorization"), "Bearer tap_fixture", "the service credential stays on the server");
      if (world.capabilitiesResponse === "unavailable") return new Response(null, { status: 503 });
      if (world.capabilitiesResponse === "not_found") return Response.json({ error: "Route unavailable" }, { status: 404 });
      if (world.capabilitiesResponse === "credential_refused") return Response.json({ error: "Invalid app credential" }, { status: 401 });
      if (world.capabilitiesResponse === "malformed") return Response.json({ capabilities: ["treasury-limit-orders-v1", 42] });
      if (world.capabilitiesResponse === "missing") return Response.json({});
      return Response.json({ capabilities: world.capabilities });
    }
    if (url.pathname === `/apps/v1/agents/${AGENT}`)
      return Response.json({ agent: AGENT, owner: world.owner, agentId: world.created ? world.agentId : null, created: world.created, host: PLATFORM_HOST, deployment: "treasury-app", signer: world.signer });
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
        scopes: world.scopes, expiresAt: world.expiresAt, createdAt: Date.now() - 1_000, publicKey: "ed25519:fixture", revoked: world.revoked, revokedAt: null, signer: world.signer }] });
    if (url.pathname === "/apps/v1/dao-consents" && req.method === "POST") {
      const body = await req.json() as { message: string };
      calls.push({ path: "daoConsents/file", input: body }); reached.push("daoConsents/file"); world.daoConsentMessage = body.message;
      const proposal = { receiverId: world.owner, actions: [{ type: "FunctionCall", params: { methodName: "add_proposal", args: {}, gas: "100000000000000", deposit: "1" } }] };
      return Response.json({ request: daoConsentRequest(), transactions: { proposal, proposalAndVote: proposal } });
    }
    if (url.pathname === `/apps/v1/dao-consents/${DAO_CONSENT_HASH}`) {
      calls.push({ path: "daoConsents/state", input: DAO_CONSENT_HASH }); reached.push("daoConsents/state");
      if (world.daoConsentState === "pending") return Response.json({ state: "pending", request: daoConsentRequest() });
      const request = daoConsentRequest(); world.scopes = request.scopes; world.expiresAt = request.expiresAt;
      return Response.json({ state: "signed", consent: { id: "e".repeat(64), deployment: "treasury-app", host: PLATFORM_HOST,
        organization: ORG, owner: world.owner, agent: AGENT, agentId: world.agentId, scopes: request.scopes, expiresAt: request.expiresAt,
        createdAt: Date.now(), publicKey: "ed25519:fixture", revoked: false, revokedAt: null, signer: "dao", ...world.daoConsentOverride } });
    }
    if (url.pathname === "/apps/v1/dao-limit-orders" && req.method === "POST") {
      calls.push({ path: "daoLimitOrders/file", input: await req.json() }); reached.push("daoLimitOrders/file");
      const proposal = { receiverId: world.owner, actions: [{ type: "FunctionCall", params: { methodName: "add_proposal", args: {}, gas: "100000000000000", deposit: "1" } }] };
      return Response.json({ request: daoOrderRequest(), transactions: { proposal, proposalAndVote: proposal } });
    }
    if (url.pathname === `/apps/v1/dao-limit-orders/${DAO_ORDER_HASH}`) {
      calls.push({ path: "daoLimitOrders/state", input: DAO_ORDER_HASH }); reached.push("daoLimitOrders/state");
      return Response.json({ state: world.daoOrderState, request: daoOrderRequest(), ...(world.daoOrderState === "relayed" && { orderState: "approved" }) });
    }
    const { matched, response } = await rpc.handle(req, { prefix: `/apps/v1/o/${ORG}/a/${AGENT}/rpc` });
    if (!matched) return new Response(null, { status: 404 });
    const decisionProcedure = url.pathname.split("/rpc/")[1];
    if (decisionProcedure === "proposals/approve" || decisionProcedure === "proposals/reject") {
      if (world.proposalDecision === "lose") return new Response(null, { status: 502 });
      if (world.proposalDecision === "plain-400") return Response.json({ error: "Reply after decision was recorded" }, { status: 400 });
    }
    if (decisionProcedure === "limitOrders/approve" || decisionProcedure === "limitOrders/reject") {
      if (world.orderDecision === "lose") return new Response(null, { status: 502 });
      if (world.orderDecision === "plain-400") return Response.json({ error: "Reply after decision was recorded" }, { status: 400 });
    }
    const procedure = reached.at(-1);
    if ((procedure === "limitOrders/get" && ["get", "both"].includes(world.orderReadFailure))
      || (procedure === "limitOrders/refresh" && ["refresh", "both"].includes(world.orderReadFailure)))
      return new Response(null, { status: 503 });
    if (reached.at(-1) === "limitOrders/create" && world.loseOrderCreates > 0) { world.loseOrderCreates--; return new Response(null, { status: 502 }); }
    if ((reached.at(-1) === "limitOrders/place" && world.placeOrder === "lose")
      || (reached.at(-1) === "limitOrders/cancel" && ["lose", "pre_submission"].includes(world.cancelOrder)))
      return new Response(null, { status: 502 });
    // A lost answer: the platform acted, the reply never arrived.
    return world.execute === "lose" && reached.at(-1) === "proposals/execute" ? new Response(null, { status: 502 }) : response;
  }

  const state = mkdtempSync(join(tmpdir(), `${name}-`));
  const tokens = new RuntimeTokens(join(state, "tokens"));
  const platform = treasuryApp({ platform: `https://${PLATFORM_HOST}`, credential: "tap_fixture", state, fetch: fetch as typeof globalThis.fetch });
  const server = createAppServer({ host: HOST, secret: SECRET, keyLookup: async () => "FullAccess", platform, tokens, secure: false, daoPolicy: async () => world.daoPolicy });
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
  return { world, calls, reached, submissions, revocations, providerCancelPosts, capabilityRequests, publicDiscoveryRequests, view, orderView, state, tokens, call, as, port: () => port };
}
