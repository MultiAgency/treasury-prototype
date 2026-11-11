import assert from "node:assert/strict";
import fs, { existsSync, fstatSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { consentMessage, limitOrderCreateInput, limitOrderQuoteInput, limitOrderText, type LimitOrderView } from "@multiagency/treasury-app-sdk";
import { requestFile, treasuryApp, type LimitOrderRequest } from "../app/treasury-app.js";

const ORG = "org_1", AGENT = "portfolio", ID = "a".repeat(32), HOST = "https://platform.example";
const REQUEST: LimitOrderRequest = { requestId: "order-1", base_asset: "nep141:wrap.near", quote_asset: "nep141:usdc.near", side: "sell",
  quantity: "1000000000000000000000000", price: "2.50", deadline: new Date(Date.now() + 4 * 3_600_000).toISOString(),
  confidential: true, expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), note: "exact order" };
const CONSENT_MESSAGE = consentMessage({ host: "platform.example", deployment: "treasury-app", organization: ORG, agent: AGENT,
  owner: "owner.sputnik-dao.near", agentId: "agent-1", scopes: ["read", "treasury", "treasury-orders"], expiresAt: REQUEST.expiresAt });
function view(state: LimitOrderView["state"] = "approved"): LimitOrderView {
  const { requestId, expiresAt, note, ...order } = REQUEST;
  return { id: ID, requestId, agentId: "agent-1", deployment: "treasury-app", organization: ORG, order,
    spendAsset: order.base_asset, spendAmount: order.quantity, outputAsset: order.quote_asset, policyRevision: 4,
    policyDigest: "b".repeat(64), strategyDigest: `sha256:${"c".repeat(64)}`, createdAt: new Date().toISOString(), expiresAt,
    note: note ?? null, sha256: "d".repeat(64), state, reason: null, approvedAt: null, correlationId: null, orderId: null,
    fillStatus: null, payoutStatus: null, isPayoutStatusFinal: null, partialFills: null, payouts: null, cancelRequestedAt: null, operation: null };
}
const fresh = () => mkdtempSync(join(tmpdir(), "treasury-orders-app-"));
function fixture(options: { loseCreate?: number; losePlace?: boolean; loseCancel?: boolean; state?: string; initial?: LimitOrderView;
  placed?: LimitOrderView; canceled?: LimitOrderView; canceledQueue?: LimitOrderView[]; getView?: unknown; refreshView?: unknown; failRead?: "get" | "refresh"; badDao?: boolean; refusePlace?: boolean; refuseCancel?: boolean; badConsent?: boolean; badConsentState?: boolean; discovery?: "absent" | "malformed" | "missing" | "offline" | "unsupported" } = {}) {
  let current = options.initial ?? view(), creates = 0, cancels = 0, consentSigned = false;
  const calls: { path: string; input: unknown }[] = [], createsReceived: unknown[] = [], routes: string[] = [];
  const record = (path: string, answer: (input: unknown) => unknown) => os.handler(({ input }) => {
    calls.push({ path, input }); return answer(input);
  });
  const rpc = new RPCHandler({ limitOrders: {
    quote: record("quote", input => ({ order: input, spendAsset: REQUEST.base_asset, spendAmount: REQUEST.quantity, outputAsset: REQUEST.quote_asset,
      warnings: [], quote: {}, ownerApproval: null, fee: null, policyRevision: 4, policyDigest: "b".repeat(64), strategyDigest: `sha256:${"c".repeat(64)}` })),
    create: record("create", input => {
      if (creates === 0) limitOrderCreateInput.parse(input);
      creates++; createsReceived.push(input);
      if (options.state) {
        const file = join(options.state, "order-requests", requestFile(ORG, AGENT, REQUEST.requestId));
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).request, input, "exact request was durable before create reached the platform");
      }
      return { ...current, state: "proposed" };
    }),
    get: record("get", () => options.getView ?? current), list: record("list", () => ({ orders: [current] })),
    refresh: record("refresh", () => options.refreshView ?? current),
    approve: record("approve", () => ({ ...current, state: "approved" })),
    reject: record("reject", () => ({ ...current, state: "rejected" })),
    place: record("place", () => {
      if (options.state) assert.equal(JSON.parse(readFileSync(join(options.state, "order-attempts", `place-${requestFile(ORG, AGENT, ID)}`), "utf8")).action, "place");
      if (options.refusePlace) throw new ORPCError("BAD_REQUEST", { message: "not executable", data: { kind: "refused", code: "not_executable" } });
      current = options.placed ?? { ...view("resting"), orderId: "provider-order-1", fillStatus: "open" }; return current;
    }),
    cancel: record("cancel", () => {
      if (options.state) assert.equal(JSON.parse(readFileSync(join(options.state, "order-attempts", `cancel-${requestFile(ORG, AGENT, ID)}`), "utf8")).action, "cancel");
      if (options.refuseCancel) throw new ORPCError("BAD_REQUEST", { message: "not cancelable", data: { kind: "refused", code: "not_open" } });
      current = options.canceledQueue?.[cancels++] ?? options.canceled ?? { ...view("cancel_requested"), orderId: "provider-order-1", fillStatus: "pending_cancel", cancelRequestedAt: new Date().toISOString() }; return current;
    }),
  } });
  const daoRequest = { id: "e".repeat(64), dao: "owner.sputnik-dao.near", organization: ORG, agent: AGENT,
    agentId: "agent-1", order: ID, verdict: "approve", votingUntil: Date.now() + 3_600_000, hash: "f".repeat(64), description: "Exact order vote" };
  const daoConsentRequest = { id: "1".repeat(64), dao: "owner.sputnik-dao.near", organization: ORG, agent: AGENT, agentId: "agent-1",
    scopes: ["read", "treasury", "treasury-orders"], expiresAt: Date.parse(REQUEST.expiresAt), votingUntil: Date.now() + 3_600_000,
    hash: "2".repeat(64), description: "Separate order consent vote" };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    routes.push(`${req.method} ${url.pathname}`);
    // A gateway discovery remains available to catch an accidental fallback from the app contract.
    if (url.pathname === "/gw/me") return Response.json({ agents: [], invoices: null, viewer: null, capabilities: ["treasury-limit-orders-v1"] });
    assert.equal(req.headers.get("authorization"), "Bearer tap_fixture", "the server SDK holds the app credential");
    if (url.pathname === "/apps/v1/capabilities") {
      assert.equal(req.method, "GET", "capability discovery is an authenticated SDK read");
      if (options.discovery === "offline") return new Response(null, { status: 503 });
      if (options.discovery === "unsupported") return Response.json({ error: "Unsupported capability route" }, { status: 404 });
      if (options.discovery === "malformed") return Response.json({ capabilities: ["treasury-limit-orders-v1", 7] });
      if (options.discovery === "missing") return Response.json({ version: 1 });
      // No gateway fields: this is the complete minimal app capabilities contract.
      return Response.json({ capabilities: options.discovery === "absent" ? [] : ["treasury-limit-orders-v1"] });
    }
    if (url.pathname === "/apps/v1/dao-consents") {
      assert.deepEqual(await req.json(), { message: CONSENT_MESSAGE });
      return Response.json({ request: { ...daoConsentRequest, ...(options.badConsent && { scopes: ["read", "treasury"] }) }, transactions: { proposal: null, proposalAndVote: null } });
    }
    if (url.pathname === `/apps/v1/dao-consents/${daoConsentRequest.id}`) {
      if (!consentSigned) return Response.json({ state: "pending", request: daoConsentRequest });
      return Response.json({ state: "signed", consent: { id: "3".repeat(64), deployment: "treasury-app", host: "platform.example", organization: ORG,
        owner: daoConsentRequest.dao, agent: AGENT, agentId: options.badConsentState ? "changed-agent" : "agent-1", scopes: daoConsentRequest.scopes,
        expiresAt: daoConsentRequest.expiresAt, createdAt: Date.now(), publicKey: "ed25519:fixture", revoked: false, revokedAt: null, signer: "dao" } });
    }
    if (url.pathname === "/apps/v1/dao-limit-orders") return Response.json({ request: { ...daoRequest, ...(options.badDao && { order: "0".repeat(32) }) }, transactions: { proposal: null, proposalAndVote: null } });
    if (url.pathname === `/apps/v1/dao-limit-orders/${daoRequest.id}`) return Response.json({ state: "relayed", request: daoRequest, orderState: "approved" });
    const { response, matched } = await rpc.handle(req, { prefix: `/apps/v1/o/${ORG}/a/${AGENT}/rpc` });
    if (!matched) return new Response(null, { status: 404 });
    const path = url.pathname.split("/").at(-1);
    if (path === options.failRead) return new Response(null, { status: 503 });
    if ((path === "create" && creates <= (options.loseCreate ?? 0)) || (path === "place" && options.losePlace) || (path === "cancel" && options.loseCancel))
      return new Response(null, { status: 502 });
    return response;
  };
  return { fetch, calls, createsReceived, routes, daoRequest, daoConsentRequest, setConsentSigned: () => { consentSigned = true; }, set: (next: LimitOrderView) => { current = next; } };
}
const appWith = (server: ReturnType<typeof fixture>, state = fresh()) => treasuryApp({ platform: HOST, credential: "tap_fixture", state, fetch: server.fetch });
const signed = (message: string) => ({ message, nonce: Buffer.alloc(32).toString("base64"), publicKey: "ed25519:11111111111111111111111111111111", signature: "ed25519:fixture" });

test("new nested order state directories are synced before a platform order call", async () => {
  const parent = fresh(), stateParent = join(parent, "new-parent"), state = join(stateParent, "app"), server = fixture({ state });
  const directories = ["order-requests", "order-attempts", "order-dao-votes", "order-dao-consents"];
  const syncs: { parent: boolean; stateParent: boolean; state: boolean; orderDirectoriesExist: boolean }[] = [];
  const sends: { path: string; parentSynced: boolean; stateParentSynced: boolean; orderDirectoriesSynced: boolean }[] = [];
  const originalSync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    const target = fstatSync(fd);
    const same = (path: string) => {
      const other = statSync(path);
      return target.dev === other.dev && target.ino === other.ino;
    };
    syncs.push({ parent: same(parent), stateParent: existsSync(stateParent) && same(stateParent), state: existsSync(state) && same(state),
      orderDirectoriesExist: directories.every(directory => existsSync(join(state, directory))) });
    return originalSync(fd);
  };
  syncBuiltinESMExports();
  try {
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path.endsWith("/limitOrders/create") || path.endsWith("/limitOrders/place"))
        sends.push({ path, parentSynced: syncs.some(entry => entry.parent), stateParentSynced: syncs.some(entry => entry.stateParent),
          orderDirectoriesSynced: syncs.some(entry => entry.state && entry.orderDirectoriesExist) });
      return server.fetch(input, init);
    };
    const app = treasuryApp({ platform: HOST, credential: "tap_fixture", state, fetch });
    assert.ok((await app.orderCreate(ORG, AGENT, REQUEST)).ok);
    assert.ok((await app.orderPlace(ORG, AGENT, ID)).ok);
    assert.deepEqual(server.calls.filter(call => call.path === "create" || call.path === "place").map(call => call.path), ["create", "place"]);
    assert.equal(sends.length, 2);
    for (const send of sends) {
      assert.equal(send.stateParentSynced, true, `the new APP_STATE entry is synced in its parent before ${send.path}`);
      assert.equal(send.parentSynced, true, `the new APP_STATE parent entry is synced in its parent before ${send.path}`);
      assert.equal(send.orderDirectoriesSynced, true, `APP_STATE is synced after creating all order claim directories before ${send.path}`);
    }
  } finally {
    fs.fsyncSync = originalSync;
    syncBuiltinESMExports();
  }
});

test("order create persists exact terms before sending and lost replies retry the identical saved body", async () => {
  const state = fresh(), server = fixture({ loseCreate: 1, state }), app = appWith(server, state);
  const answer = await app.orderCreate(ORG, AGENT, REQUEST);
  assert.equal(answer.ok && answer.value.state, "proposed");
  assert.equal(server.createsReceived.length, 2);
  assert.deepEqual(server.createsReceived, [REQUEST, REQUEST]);
  const restarted = appWith(server, state);
  assert.ok((await restarted.orderCreate(ORG, AGENT, REQUEST)).ok);
  assert.deepEqual(server.createsReceived[2], REQUEST);
  for (const changed of [{ price: "2.51" }, { quantity: "2" }, { deadline: new Date(Date.now() + 5 * 3_600_000).toISOString() }, { note: "changed" }]) {
    const conflict = await restarted.orderCreate(ORG, AGENT, { ...REQUEST, ...changed });
    assert.equal(!conflict.ok && "code" in conflict && conflict.code, "request_conflict");
  }
  assert.equal(server.createsReceived.length, 3, "changed terms never reach create");
});

test("a saved request keeps its exact deadline and body after the deadline passes", async () => {
  const state = fresh(), server = fixture(), app = appWith(server, state);
  await app.orderCreate(ORG, AGENT, REQUEST);
  const now = Date.now;
  Date.now = () => Date.parse(REQUEST.deadline) + 1;
  try { await appWith(server, state).orderCreate(ORG, AGENT, REQUEST); } finally { Date.now = now; }
  assert.deepEqual(server.createsReceived, [REQUEST, REQUEST]);
});

test("two lost create replies retain the request for a later identical retry; invalid and torn requests send nothing", async () => {
  const state = fresh(), server = fixture({ loseCreate: 2 }), app = appWith(server, state);
  const lost = await app.orderCreate(ORG, AGENT, REQUEST);
  assert.equal(!lost.ok && lost.kind, "unknown");
  assert.ok((await appWith(server, state).orderCreate(ORG, AGENT, REQUEST)).ok);
  assert.deepEqual(server.createsReceived, [REQUEST, REQUEST, REQUEST]);
  const bad = await app.orderCreate(ORG, AGENT, { ...REQUEST, requestId: "new", price: "1e3" });
  assert.equal(!bad.ok && "code" in bad && bad.code, "invalid_request");
  writeFileSync(join(state, "order-requests", requestFile(ORG, AGENT, REQUEST.requestId)), "{");
  const torn = await app.orderCreate(ORG, AGENT, REQUEST);
  assert.equal(!torn.ok && "code" in torn && torn.code, "state_review_required");
  assert.equal(server.createsReceived.length, 3);
});

test("order approval and rejection relay only the SDK's exact current signing text", async () => {
  const server = fixture(), app = appWith(server), order = view();
  // The digest and exact base quantity, decimal price, expiry and policy binding are all in the SDK's text.
  for (const altered of [limitOrderText({ ...order, order: { ...order.order, quantity: "2" } }, "approve"), limitOrderText(order, "reject"), `${limitOrderText(order, "approve")}\n`]) {
    const refused = await app.orderDecide(ORG, AGENT, ID, "approve", signed(altered));
    assert.equal(!refused.ok && "code" in refused && refused.code, "signature_text_mismatch");
  }
  assert.equal(server.calls.filter(c => ["approve", "reject"].includes(c.path)).length, 0);
  for (const verdict of ["approve", "reject"] as const) {
    const message = limitOrderText(order, verdict);
    assert.ok((await appWith(server).orderDecide(ORG, AGENT, ID, verdict, signed(message))).ok);
    assert.deepEqual(server.calls.at(-1), { path: verdict, input: { id: ID, signed: signed(message) } });
  }
});

test("lost placement answers use get and refresh; repeated, concurrent and restarted requests never place again", async () => {
  const state = fresh(), server = fixture({ losePlace: true, state }), app = appWith(server, state);
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    (index % 2 ? appWith(server, state) : app).orderPlace(ORG, AGENT, ID)));
  assert.ok(results.every(answer => answer.ok && answer.value.state === "resting"));
  assert.equal(server.calls.filter(c => c.path === "place").length, 1);
  assert.ok(server.calls.some(c => c.path === "get") && server.calls.some(c => c.path === "refresh"));
  const restarted = appWith(server, state);
  assert.deepEqual(restarted.orderAttempted(ORG, AGENT, ID), { place: true, cancel: false });
  await restarted.orderPlace(ORG, AGENT, ID);
  assert.equal(server.calls.filter(c => c.path === "place").length, 1);
  assert.equal(server.calls.filter(c => c.path === "create").length, 0, "no replacement proposal");
});

test("a lost placement that still reads approved remains unknown and is never retried", async () => {
  const state = fresh(), server = fixture({ losePlace: true, placed: view("approved") });
  for (let i = 0; i < 2; i++) {
    const result = await appWith(server, state).orderPlace(ORG, AGENT, ID);
    assert.equal(!result.ok && result.kind, "unknown");
  }
  assert.equal(server.calls.filter(c => c.path === "place").length, 1);
});

test("a torn placement claim and cancellation claim remain poll-only across restart", async () => {
  const state = fresh(), server = fixture(), app = appWith(server, state);
  for (const action of ["place", "cancel"] as const) writeFileSync(join(state, "order-attempts", `${action}-${requestFile(ORG, AGENT, ID)}`), "{");
  assert.equal((await app.orderPlace(ORG, AGENT, ID)).ok, false);
  assert.equal((await app.orderCancel(ORG, AGENT, ID)).ok, false);
  assert.deepEqual(appWith(server, state).orderAttempted(ORG, AGENT, ID), { place: true, cancel: true });
  assert.equal(server.calls.filter(c => ["place", "cancel", "create"].includes(c.path)).length, 0);
});

test("cancellation is one attempt; a lost answer uses live reads and keeps partial fills and payouts", async () => {
  const canceled = { ...view("cancel_requested"), cancelRequestedAt: new Date().toISOString(), orderId: "provider-order-1", fillStatus: "pending_cancel",
    partialFills: [{ amount: "30", tx: "fill-1" }], payouts: { usdc: { amount: "50", status: "in_progress" } }, payoutStatus: "in_progress", isPayoutStatusFinal: false };
  const state = fresh(), server = fixture({ loseCancel: true, canceled, state });
  for (let i = 0; i < 3; i++) {
    const result = await appWith(server, state).orderCancel(ORG, AGENT, ID);
    assert.ok(result.ok);
    assert.deepEqual(result.value.partialFills, canceled.partialFills);
    assert.deepEqual(result.value.payouts, canceled.payouts);
    assert.equal(result.value.state, "cancel_requested");
  }
  assert.equal(server.calls.filter(c => c.path === "cancel").length, 1);
  assert.ok(server.calls.some(c => c.path === "refresh"));
});

test("a lost cancellation without a cancellation receipt remains unknown; new app calls only observe", async () => {
  const state = fresh(), server = fixture({ loseCancel: true, canceled: { ...view("partially_filled"), fillStatus: "partially_filled" } });
  const first = await appWith(server, state).orderCancel(ORG, AGENT, ID);
  const second = await appWith(server, state).orderCancel(ORG, AGENT, ID);
  assert.equal(!first.ok && first.kind, "unknown");
  assert.equal(!second.ok && second.kind, "unknown");
  assert.equal(server.calls.filter(c => c.path === "cancel").length, 1);
});

test("quote/list/get/refresh preserve distinct partial-fill, payout-failed, unknown and final-payout evidence", async () => {
  const server = fixture(), app = appWith(server);
  const { requestId, expiresAt, note, ...terms } = REQUEST;
  const quote = await app.orderQuote(ORG, AGENT, terms);
  assert.equal(quote.ok && quote.value.spendAmount, REQUEST.quantity);
  for (const current of [
    { ...view("partially_filled"), fillStatus: "partially_filled", partialFills: [{ amount: "30" }], payoutStatus: "not_started", isPayoutStatusFinal: false },
    { ...view("payout_failed"), fillStatus: "filled", payoutStatus: "failed", isPayoutStatusFinal: true },
    { ...view("unknown"), fillStatus: "unrecognized", reason: "Unknown provider status" },
    { ...view("completed"), fillStatus: "canceled", partialFills: [{ amount: "30" }], payouts: { usdc: { status: "completed" } }, payoutStatus: "completed", isPayoutStatusFinal: true },
  ]) {
    server.set(current);
    const read = await app.orderRefresh(ORG, AGENT, ID);
    assert.ok(read.ok); assert.deepEqual(read.value, current);
    const list = await app.orderList(ORG, AGENT);
    assert.ok(list.ok); assert.deepEqual(list.value.orders, [current]);
    const get = await app.orderGet(ORG, AGENT, ID);
    assert.ok(get.ok); assert.equal(get.value.state, current.state);
  }
});

test("DAO order file saves its exact binding before a later state read can relay, including after restart", async () => {
  const state = fresh(), server = fixture(), app = appWith(server, state);
  assert.equal((await app.daoOrderState(ORG, AGENT, ID, server.daoRequest.id)).ok, false);
  assert.equal(server.routes.length, 0, "no relay-triggering read for an unknown hash");
  const filed = await app.daoOrderFile(ORG, AGENT, ID, "approve");
  assert.ok(filed.ok);
  const restarted = appWith(server, state);
  assert.deepEqual(restarted.daoOrderRequest(ORG, AGENT, server.daoRequest.id), server.daoRequest);
  assert.equal((await restarted.daoOrderState(ORG, AGENT, "0".repeat(32), server.daoRequest.id)).ok, false);
  assert.equal((await restarted.daoOrderState("another-org", AGENT, ID, server.daoRequest.id)).ok, false);
  assert.equal(server.routes.length, 1, "wrong bindings never call state");
  const relayed = await restarted.daoOrderState(ORG, AGENT, ID, server.daoRequest.id);
  assert.equal(relayed.ok && relayed.value.state, "relayed");
  assert.equal(server.routes.length, 2);
});

test("a DAO filing for different order terms is refused without offering transactions", async () => {
  const state = fresh(), server = fixture({ badDao: true }), app = appWith(server, state);
  const filed = await app.daoOrderFile(ORG, AGENT, ID, "approve");
  assert.equal(!filed.ok && "code" in filed && filed.code, "dao_request_mismatch");
  assert.deepEqual(readdirSync(join(state, "order-dao-votes")), []);
});


test("even a refused placement or cancellation consumes this app's one attempt", async () => {
  const state = fresh(), server = fixture({ refusePlace: true, refuseCancel: true, state }), app = appWith(server, state);
  assert.equal((await app.orderPlace(ORG, AGENT, ID)).ok, false);
  assert.equal((await app.orderCancel(ORG, AGENT, ID)).ok, false);
  await appWith(server, state).orderPlace(ORG, AGENT, ID);
  await appWith(server, state).orderCancel(ORG, AGENT, ID);
  assert.equal(server.calls.filter(c => c.path === "place").length, 1);
  assert.equal(server.calls.filter(c => c.path === "cancel").length, 1);
});


test("host discovery uses the authenticated SDK capabilities read and accepts the minimal app contract", async () => {
  const server = fixture(), advertised = await appWith(server).discovery();
  assert.ok(advertised.ok && advertised.value.capabilities.includes("treasury-limit-orders-v1"));
  assert.deepEqual(server.routes, ["GET /apps/v1/capabilities"], "no gateway discovery or extra requests");
});

test("capability absence, malformed data, unavailable and unsupported hosts fail closed without gateway fallback", async () => {
  const absentServer = fixture({ discovery: "absent" }), absent = await appWith(absentServer).discovery();
  assert.ok(absent.ok); assert.deepEqual(absent.value.capabilities, []);
  assert.deepEqual(absentServer.routes, ["GET /apps/v1/capabilities"]);
  for (const discovery of ["malformed", "missing", "offline", "unsupported"] as const) {
    const server = fixture({ discovery }), answer = await appWith(server).discovery();
    assert.equal(answer.ok, false, discovery);
    assert.deepEqual(server.routes, ["GET /apps/v1/capabilities"], `${discovery}: no /gw/me fallback`);
  }
});

test("the frozen SDK schemas refuse exponent prices and quantities without throwing", () => {
  const { requestId, expiresAt, note, ...terms } = REQUEST;
  for (const malformed of [{ price: "1e3" }, { price: "1E3" }, { price: "1.5e-2" }, { quantity: "1e3" }]) {
    assert.doesNotThrow(() => {
      assert.equal(limitOrderQuoteInput.safeParse({ ...terms, ...malformed }).success, false);
      assert.equal(limitOrderCreateInput.safeParse({ ...REQUEST, ...malformed }).success, false);
    }, JSON.stringify(malformed));
  }
});

test("malformed order quote and create terms refuse normally without a platform request", async () => {
  const server = fixture(), app = appWith(server);
  const { requestId, expiresAt, note, ...terms } = REQUEST;
  for (const malformed of [{ price: "1e3" }, { price: "abc" }, { quantity: "abc" }]) {
    const quote = await app.orderQuote(ORG, AGENT, { ...terms, ...malformed });
    assert.equal(!quote.ok && "code" in quote && quote.code, "invalid_request");
    const create = await app.orderCreate(ORG, AGENT, { ...REQUEST, ...malformed });
    assert.equal(!create.ok && "code" in create && create.code, "invalid_request");
  }
  assert.equal(server.calls.length, 0);
  assert.equal(server.routes.length, 0, "validation refuses before any SDK network call");
});

test("DAO additional order consent is canonical, durable and polled by its exact binding across restart", async () => {
  const state = fresh(), server = fixture(), app = appWith(server, state);
  assert.equal((await app.daoOrderConsentState(ORG, AGENT, server.daoConsentRequest.id)).ok, false);
  assert.equal(server.routes.length, 0, "an unfiled consent hash never triggers a signature relay");
  const invalid = await app.daoOrderConsentFile(CONSENT_MESSAGE + " ");
  assert.equal(!invalid.ok && "code" in invalid && invalid.code, "invalid_consent");
  const filed = await app.daoOrderConsentFile(CONSENT_MESSAGE);
  assert.ok(filed.ok);
  const restarted = appWith(server, state);
  assert.deepEqual(restarted.daoOrderConsentRequest(ORG, AGENT, server.daoConsentRequest.id), server.daoConsentRequest);
  assert.equal((await restarted.daoOrderConsentState("other-org", AGENT, server.daoConsentRequest.id)).ok, false);
  const pending = await restarted.daoOrderConsentState(ORG, AGENT, server.daoConsentRequest.id);
  assert.equal(pending.ok && pending.value.state, "pending");
  server.setConsentSigned();
  const signed = await restarted.daoOrderConsentState(ORG, AGENT, server.daoConsentRequest.id);
  assert.equal(signed.ok && signed.value.state, "signed");
});

test("different DAO consent terms or a signed consent for a replaced provider identity are refused", async () => {
  const badFile = fixture({ badConsent: true }), app = appWith(badFile);
  const filed = await app.daoOrderConsentFile(CONSENT_MESSAGE);
  assert.equal(!filed.ok && "code" in filed && filed.code, "dao_request_mismatch");
  const wrongState = fixture({ badConsentState: true }), stateApp = appWith(wrongState);
  assert.ok((await stateApp.daoOrderConsentFile(CONSENT_MESSAGE)).ok);
  wrongState.setConsentSigned();
  const stored = await stateApp.daoOrderConsentState(ORG, AGENT, wrongState.daoConsentRequest.id);
  assert.equal(!stored.ok && "code" in stored && stored.code, "dao_request_mismatch");
});


const preparedCancellation = (): LimitOrderView => ({ ...view("cancel_requested"), orderId: "provider-order-1", fillStatus: "open",
  cancelRequestedAt: new Date().toISOString(), cancelMayResume: true });
const submittedCancellation = (): LimitOrderView => ({ ...preparedCancellation(), fillStatus: "pending_cancel", cancelMayResume: false });

test("an explicit cancellation continuation uses fresh positive proof and the same ID; initial duplicate calls stay poll-only", async () => {
  const state = fresh(), prepared = preparedCancellation(), submitted = submittedCancellation();
  const server = fixture({ state, loseCancel: true, canceledQueue: [prepared, submitted] }), app = appWith(server, state);
  const first = await app.orderCancel(ORG, AGENT, ID);
  assert.ok(first.ok && first.value.cancelMayResume === true);
  await app.orderCancel(ORG, AGENT, ID);
  assert.equal(server.calls.filter(call => call.path === "cancel").length, 1, "positive proof never makes a duplicate initial cancel continue automatically");
  const before = server.calls.length;
  const continued = await app.orderContinueCancel(ORG, AGENT, ID);
  assert.ok(continued.ok && continued.value.cancelMayResume === false);
  assert.deepEqual(server.calls.slice(before).map(call => call.path), ["get", "refresh", "cancel", "get", "refresh"], "fresh proof precedes the one continuation; a lost reply adds reads only");
  assert.deepEqual(server.calls.filter(call => call.path === "cancel").map(call => call.input), [{ id: ID }, { id: ID }]);
  const retry = await appWith(server, state).orderContinueCancel(ORG, AGENT, ID);
  assert.equal(!retry.ok && "code" in retry && retry.code, "cancel_not_resumable");
  assert.equal(server.calls.filter(call => call.path === "cancel").length, 2);
  assert.equal(server.calls.filter(call => call.path === "create" || call.path === "place").length, 0);
});

test("continuation requires strict latest boolean proof; omitted, false and malformed evidence cannot cancel", async () => {
  const prepared = preparedCancellation(), { cancelMayResume: _proof, ...withoutProof } = prepared;
  for (const refreshView of [withoutProof, ...[false, null, "true", 1, {}, []].map(cancelMayResume => ({ ...prepared, cancelMayResume }))]) {
    const server = fixture({ initial: prepared, refreshView }), state = fresh();
    const answer = await appWith(server, state).orderContinueCancel(ORG, AGENT, ID);
    assert.equal(answer.ok, false, JSON.stringify(refreshView));
    assert.equal(server.calls.filter(call => call.path === "cancel").length, 0);
    assert.deepEqual(appWith(server, state).orderAttempted(ORG, AGENT, ID), { place: false, cancel: false }, "unproved continuation creates no cancel claim");
  }
});

test("a stale positive get followed by a fresh negative refresh stays read-only", async () => {
  const server = fixture({ getView: preparedCancellation(), refreshView: submittedCancellation() });
  const answer = await appWith(server).orderContinueCancel(ORG, AGENT, ID);
  assert.equal(!answer.ok && "code" in answer && answer.code, "cancel_not_resumable");
  assert.deepEqual(server.calls.map(call => call.path), ["get", "refresh"]);
});

test("continuation rejects a different returned order ID before any cancellation", async () => {
  for (const read of ["getView", "refreshView"] as const) {
    const server = fixture({ initial: preparedCancellation(), [read]: { ...preparedCancellation(), id: "b".repeat(32) } });
    const answer = await appWith(server).orderContinueCancel(ORG, AGENT, ID);
    assert.equal(!answer.ok && "code" in answer && answer.code, "order_identity_mismatch");
    assert.equal(server.calls.filter(call => call.path === "cancel").length, 0);
  }
});

test("failed cancellation-proof reads refuse continuation and invalid IDs make no call", async () => {
  for (const failRead of ["get", "refresh"] as const) {
    const server = fixture({ initial: preparedCancellation(), failRead });
    const answer = await appWith(server).orderContinueCancel(ORG, AGENT, ID);
    assert.equal(!answer.ok && answer.kind, "unavailable");
    assert.equal(server.calls.filter(call => call.path === "cancel").length, 0);
  }
  const server = fixture({ initial: preparedCancellation() });
  const answer = await appWith(server).orderContinueCancel(ORG, AGENT, "invalid");
  assert.equal(!answer.ok && "code" in answer && answer.code, "invalid_request");
  assert.equal(server.calls.length, 0);
});

test("concurrent explicit continuations coalesce across relay instances sharing the same app state", async () => {
  const state = fresh(), server = fixture({ state, initial: preparedCancellation(), canceled: submittedCancellation() });
  const answers = await Promise.all(Array.from({ length: 10 }, () => appWith(server, state).orderContinueCancel(ORG, AGENT, ID)));
  assert.ok(answers.every(answer => answer.ok && answer.value.cancelMayResume === false));
  assert.deepEqual(server.calls.map(call => call.path), ["get", "refresh", "cancel"]);
  assert.deepEqual(appWith(server, state).orderAttempted(ORG, AGENT, ID), { place: false, cancel: true });
  await appWith(server, state).orderContinueCancel(ORG, AGENT, ID);
  assert.equal(server.calls.filter(call => call.path === "cancel").length, 1, "a later explicit request needs fresh proof again");
});

test("continuing a prepared cancellation retains a torn local claim and final payout evidence after a lost reply", async () => {
  const state = fresh(), final = { ...submittedCancellation(), state: "completed" as const, fillStatus: "canceled", payoutStatus: "completed",
    isPayoutStatusFinal: true, partialFills: [{ amount: "30" }], payouts: { usdc: { amount: "50", status: "completed" } } };
  const server = fixture({ initial: preparedCancellation(), canceled: final, loseCancel: true }), app = appWith(server, state);
  const claim = join(state, "order-attempts", `cancel-${requestFile(ORG, AGENT, ID)}`);
  writeFileSync(claim, "{");
  const answer = await app.orderContinueCancel(ORG, AGENT, ID);
  assert.ok(answer.ok); assert.deepEqual(answer.value, final);
  assert.equal(readFileSync(claim, "utf8"), "{", "continuation never deletes or rewrites the original app claim");
  assert.equal(server.calls.filter(call => call.path === "cancel").length, 1);
  await app.orderContinueCancel(ORG, AGENT, ID);
  assert.equal(server.calls.filter(call => call.path === "cancel").length, 1, "attempted cancellation remains read-only after final payout");
});

test("unknown order state retains positive platform resume proof after a lost cancel reply", async () => {
  // The SDK computes cancellation proof independently of fill finality: unknown is not evidence that a POST began.
  const prepared = { ...preparedCancellation(), state: "unknown" as const, reason: "Live fill state is not established" };
  const submitted = { ...prepared, cancelMayResume: false };
  const state = fresh(), server = fixture({ state, initial: prepared, canceledQueue: [prepared, submitted], loseCancel: true });
  const app = appWith(server, state);
  const lost = await app.orderCancel(ORG, AGENT, ID);
  assert.ok(lost.ok); assert.equal(lost.value.state, "unknown"); assert.equal(lost.value.cancelMayResume, true);
  const continued = await app.orderContinueCancel(ORG, AGENT, ID);
  assert.ok(continued.ok); assert.equal(continued.value.state, "unknown"); assert.equal(continued.value.cancelMayResume, false);
  assert.equal(server.calls.filter(call => call.path === "cancel").length, 2);
  await app.orderContinueCancel(ORG, AGENT, ID);
  assert.equal(server.calls.filter(call => call.path === "cancel").length, 2, "submission proof overrides an unchanged unknown fill state");
});
