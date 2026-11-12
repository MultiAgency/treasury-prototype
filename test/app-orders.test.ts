import assert from "node:assert/strict";
import { test } from "node:test";
import { consentMessage, limitOrderText } from "@multiagency/treasury-app-sdk";
import { AGENT, appPlatform, DAO, DAO_CONSENT_HASH, DAO_ORDER_HASH, HOST, ID, MEMBER, ORG, OWNER, PLATFORM_HOST, READER, USDC, WNEAR } from "./fixtures/app-platform.js";

const { world, calls, reached, submissions, providerCancelPosts, capabilityRequests, publicDiscoveryRequests, orderView, call, as, tokens } = appPlatform("app-orders");
const where = `organization=${ORG}&agent=${AGENT}`;
const terms = () => ({ base_asset: WNEAR, quote_asset: USDC, side: "sell", quantity: "1000000000000000000000000", price: "2.5",
  deadline: world.orderDeadline, confidential: true });
const request = () => ({ ...terms(), requestId: "order-1", expiresAt: world.orderExpiry });
const signed = (message: string) => ({ message, nonce: Buffer.alloc(32, 7).toString("base64"),
  publicKey: "ed25519:11111111111111111111111111111111", signature: "ed25519:fixture-signature" });
const post = (path: string, body: object = {}, account = OWNER) => call(path, { method: "POST", headers: as(account), body: { organization: ORG, agent: AGENT, ...body } });
const read = (path = "/app/orders", account = OWNER) => call(`${path}?${where}`, { headers: as(account) });
const permitOrders = () => { world.scopes = ["read", "treasury", "treasury-orders"]; };
const orderCalls = () => reached.filter(path => path.startsWith("limitOrders/"));
const dao = () => { permitOrders(); world.owner = DAO; world.signer = "dao"; world.consentFollows = true; };
const cancellationCalls = () => calls.filter(call => call.path === "limitOrders/cancel");
const pendingCancellation = async () => {
  permitOrders(); world.orderState = "resting"; world.cancelOrder = "pre_submission";
  await post(`/app/orders/${ID}/cancel`);
  assert.equal(cancellationCalls().length, 1); assert.deepEqual(providerCancelPosts, []);
};

test("a connected owner explicitly renews with the SDK's separate treasury-orders consent", async () => {
  const old = await read("/app/orders/access");
  assert.equal(old.status, 200);
  assert.equal(old.body.capable, true);
  assert.equal(old.body.consented, false, "existing treasury connection grants no orders");
  const prepared = await post("/app/connect/prepare", { orders: true });
  assert.equal(prepared.status, 200);
  assert.deepEqual(prepared.body.scopes, ["read", "treasury", "treasury-orders"]);
  const parsed = JSON.parse(prepared.body.message);
  assert.equal(prepared.body.message, consentMessage({ host: PLATFORM_HOST, deployment: "treasury-app", organization: ORG,
    owner: OWNER, agent: AGENT, agentId: world.agentId, scopes: ["read", "treasury", "treasury-orders"], expiresAt: parsed.expiresAt }));
  assert.equal(prepared.body.recipient, PLATFORM_HOST);
  assert.ok(!prepared.body.scopes.includes("treasury-execute"), "order consent does not add unattended execution");
  assert.equal((await post("/app/connect/prepare", { orders: "yes" })).status, 400);
  permitOrders();
  assert.equal((await read("/app/orders/access")).body.consented, true);
  assert.ok(capabilityRequests.length > 0);
  assert.ok(capabilityRequests.every(request => request.path === "/apps/v1/capabilities" && request.method === "GET" && request.authorization === "Bearer tap_fixture"));
  assert.deepEqual(publicDiscoveryRequests, [], "a minimal app capability reply requires no owner discovery fallback");
});

test("old Treasury and execute consent, expired consent and revoked consent cannot reach order methods", async () => {
  for (const scopes of [["read", "treasury"], ["read", "treasury", "treasury-execute"], ["read", "treasury-orders"]]) {
    world.scopes = scopes;
    assert.equal((await post("/app/orders", request())).status, 403, scopes.join(","));
    assert.equal((await post(`/app/orders/${ID}/cancel/continue`)).status, 403, "continuation requires the separate order consent");
  }
  permitOrders(); world.expiresAt = Date.now() - 1;
  assert.equal((await read()).status, 403);
  world.expiresAt = Date.now() + 60_000; world.revoked = true;
  assert.equal((await post(`/app/orders/${ID}/refresh`)).status, 403);
  assert.deepEqual(orderCalls(), []);
});

test("capability discovery grants no consent and an absent capability disables every order control", async () => {
  permitOrders(); world.capabilities = [];
  const access = await read("/app/orders/access");
  assert.equal(access.body.capable, false);
  assert.equal(access.body.mayRead, false);
  for (const result of [await post("/app/orders", request()), await post("/app/orders/quote", terms()), await post("/app/connect/prepare", { orders: true })])
    assert.ok([403, 409].includes(result.status));
  assert.deepEqual(orderCalls(), []);
  assert.deepEqual(submissions, []);
  assert.deepEqual(publicDiscoveryRequests, []);
});

for (const response of ["malformed", "missing", "unavailable", "not_found", "credential_refused"] as const) {
  test(`order authority and consent preparation fail closed on ${response} app capabilities, without public fallback`, async () => {
    permitOrders(); world.capabilitiesResponse = response;
    const access = await read("/app/orders/access");
    assert.equal(access.status, 200);
    assert.deepEqual([access.body.capable, access.body.mayRead, access.body.mayPrepare, access.body.mayExecute], [false, false, false, false]);
    const blocked = [await read(), await post("/app/orders/quote", terms()), await post("/app/orders", request()),
      await post(`/app/orders/${ID}/decide`, { verdict: "approve", signed: signed(limitOrderText(orderView(), "approve")) }),
      await post(`/app/orders/${ID}/place`), await post(`/app/orders/${ID}/cancel`), await post(`/app/orders/${ID}/refresh`),
      await post(`/app/orders/${ID}/cancel/continue`),
      await post("/app/connect/prepare", { orders: true })];
    for (const result of blocked) assert.equal(result.status, 409);
    dao();
    assert.equal((await post("/app/orders/consent", {}, MEMBER)).status, 409, "DAO order consent also needs the authenticated host capability");
    assert.deepEqual(orderCalls(), []);
    assert.deepEqual(submissions, []);
    assert.ok(!reached.some(path => path.startsWith("daoConsents/") || path.startsWith("daoLimitOrders/")));
    assert.equal(capabilityRequests.length, 11, "every attempted order and consent request rereads host capability");
    assert.ok(capabilityRequests.every(request => request.path === "/apps/v1/capabilities" && request.method === "GET" && request.authorization === "Bearer tap_fixture"));
    assert.deepEqual(publicDiscoveryRequests, [], "never fall back to /gw/me after a failed authenticated discovery");
  });
}

test("the current owner reads the SDK's exact signing text and only that decision is relayed", async () => {
  permitOrders();
  const result = await read(`/app/orders/${ID}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.sign, { recipient: PLATFORM_HOST, approve: limitOrderText(orderView(), "approve"), reject: limitOrderText(orderView(), "reject") });
  const wrong = await post(`/app/orders/${ID}/decide`, { verdict: "approve", signed: signed(result.body.sign.approve.replace("2.5", "2.6")) });
  assert.equal(wrong.body.result.code, "signature_text_mismatch");
  assert.ok(!reached.includes("limitOrders/approve"));
  const approved = await post(`/app/orders/${ID}/decide`, { verdict: "approve", signed: signed(result.body.sign.approve) });
  assert.equal(approved.body.result.value.state, "approved");
  assert.deepEqual(calls.find(c => c.path === "limitOrders/approve")!.input, { id: ID, signed: signed(result.body.sign.approve) });
  const rejected = await post(`/app/orders/${ID}/decide`, { verdict: "reject", signed: signed(result.body.sign.reject) });
  assert.equal(rejected.body.result.value.state, "rejected");
  assert.equal((await post(`/app/orders/${ID}/decide`, { verdict: "approve" })).status, 400);
});

test("order creation loses a reply and repeats only the saved body; changed terms never become a replacement", async () => {
  permitOrders(); world.loseOrderCreates = 1;
  const made = await post("/app/orders", request());
  assert.equal(made.body.result.value.id, ID);
  const created = calls.filter(c => c.path === "limitOrders/create");
  assert.equal(created.length, 2);
  assert.deepEqual(created.map(c => c.input), [request(), request()]);
  const conflict = await post("/app/orders", { ...request(), price: "2.6" });
  assert.equal(conflict.body.result.code, "request_conflict");
  assert.equal(calls.filter(c => c.path === "limitOrders/create").length, 2);
  assert.equal((await post("/app/orders", { ...request(), requestId: "invalid-order", quantity: "0" })).body.result.code, "invalid_request");
});

test("placement with a lost reply remains a single attempt across repeated owner requests", async () => {
  permitOrders(); world.orderState = "approved"; world.placeOrder = "lose";
  await post(`/app/orders/${ID}/place`);
  await post(`/app/orders/${ID}/place`);
  await post(`/app/orders/${ID}/refresh`);
  assert.equal(reached.filter(path => path === "limitOrders/place").length, 1);
  assert.ok(reached.includes("limitOrders/get"));
  assert.ok(reached.includes("limitOrders/refresh"));
  assert.ok(!reached.includes("limitOrders/create"), "an uncertain placement never creates a compensating order");
});

test("cancellation with a lost reply remains a single attempt followed only by observations", async () => {
  permitOrders(); world.orderState = "resting"; world.cancelOrder = "lose";
  await post(`/app/orders/${ID}/cancel`);
  await post(`/app/orders/${ID}/cancel`);
  await post(`/app/orders/${ID}/refresh`);
  assert.equal(reached.filter(path => path === "limitOrders/cancel").length, 1);
  assert.ok(reached.includes("limitOrders/refresh"));
});

test("only an explicit continuation with fresh pre-submission proof may finish the same cancellation", async () => {
  await pendingCancellation();
  const readback = await read(`/app/orders/${ID}`);
  assert.equal(readback.body.result.value.cancelMayResume, true); assert.equal(readback.body.attempts.cancel, true);
  await post(`/app/orders/${ID}/cancel`);
  assert.equal(cancellationCalls().length, 1, "ordinary repeated cancellation only reads even when proof permits an explicit continuation");
  const before = orderCalls().length;
  world.cancelOrder = "cancel_requested";
  const continued = await post(`/app/orders/${ID}/cancel/continue`);
  assert.equal(continued.body.result.value.state, "cancel_requested");
  assert.equal(continued.body.result.value.cancelMayResume, false);
  const following = orderCalls().slice(before);
  assert.ok(following.includes("limitOrders/get") && following.includes("limitOrders/refresh"));
  assert.equal(following.at(-1), "limitOrders/cancel", "fresh platform reads precede the explicit same-ID continuation");
  assert.deepEqual(cancellationCalls().map(call => call.input), [{ id: ID }, { id: ID }]);
  assert.deepEqual(providerCancelPosts, [{ id: ID }], "the prepared claim had not begun its sole provider POST");
  await post(`/app/orders/${ID}/cancel/continue`);
  assert.equal(cancellationCalls().length, 2, "post-submission proof no longer permits a cancellation call");
  assert.ok(!reached.includes("limitOrders/create") && !reached.includes("limitOrders/place"));
});

for (const proof of [false, undefined, "true", 1, null, { phase: "prepared" }]) {
  test(`cancellation continuation stays read-only with ${JSON.stringify(proof) ?? "missing"} resume evidence`, async () => {
    await pendingCancellation();
    if (typeof proof === "boolean" || proof === undefined) world.cancelMayResume = proof;
    else world.orderViewOverride = { cancelMayResume: proof };
    const result = await post(`/app/orders/${ID}/cancel/continue`, { cancelMayResume: true });
    assert.equal(result.body.result.ok, false, "browser-supplied proof never authorizes a platform call");
    assert.equal(cancellationCalls().length, 1); assert.deepEqual(providerCancelPosts, []);
    assert.ok(!reached.includes("limitOrders/create") && !reached.includes("limitOrders/place"));
  });
}

for (const failure of ["get", "refresh"] as const) {
  test(`a failed fresh ${failure} leaves pending cancellation read-only`, async () => {
    await pendingCancellation(); world.orderReadFailure = failure;
    const result = await post(`/app/orders/${ID}/cancel/continue`);
    assert.equal(result.body.result.ok, false);
    assert.equal(cancellationCalls().length, 1); assert.deepEqual(providerCancelPosts, []);
  });
}

test("a stale positive view cannot authorize continuation after fresh platform evidence changes", async () => {
  await pendingCancellation();
  assert.equal((await read(`/app/orders/${ID}`)).body.result.value.cancelMayResume, true);
  world.cancelMayResumeAfterGet = false;
  const result = await post(`/app/orders/${ID}/cancel/continue`, { cancelMayResume: true });
  assert.equal(result.body.result.ok, false); assert.equal(result.body.result.code, "cancel_not_resumable");
  assert.equal(cancellationCalls().length, 1); assert.deepEqual(providerCancelPosts, []);
});

test("a positive resume view for another order ID never continues the requested cancellation", async () => {
  await pendingCancellation(); world.orderViewOverride = { id: "e".repeat(32), cancelMayResume: true };
  const result = await post(`/app/orders/${ID}/cancel/continue`);
  assert.equal(result.body.result.code, "order_identity_mismatch");
  assert.equal(cancellationCalls().length, 1); assert.deepEqual(providerCancelPosts, []);
});

test("an attempted continuation with a lost reply stays poll-only and retains partial-fill and final-payout tracking", async () => {
  await pendingCancellation(); world.cancelOrder = "lose";
  await post(`/app/orders/${ID}/cancel/continue`);
  assert.equal(world.cancelMayResume, false); assert.deepEqual(providerCancelPosts, [{ id: ID }]);
  await post(`/app/orders/${ID}/cancel/continue`); await post(`/app/orders/${ID}/cancel`);
  assert.equal(cancellationCalls().length, 2, "one initial pre-submission call and one proven continuation, never a retry after provider submission");
  world.orderState = "partially_filled"; world.fillStatus = "partially_filled"; world.payoutStatus = "in_progress"; world.isPayoutStatusFinal = false;
  world.partialFills = [{ quantity: "500000000000000000000000", transaction: "fixture-fill" }];
  const partial = (await post(`/app/orders/${ID}/refresh`)).body.result.value;
  assert.equal(partial.state, "partially_filled"); assert.deepEqual(partial.partialFills, world.partialFills); assert.equal(partial.cancelMayResume, false);
  world.orderState = "completed"; world.fillStatus = "canceled"; world.payoutStatus = "completed"; world.isPayoutStatusFinal = true;
  const final = (await post(`/app/orders/${ID}/refresh`)).body.result.value;
  assert.deepEqual([final.state, final.fillStatus, final.payoutStatus, final.isPayoutStatusFinal], ["completed", "canceled", "completed", true]);
  assert.equal(cancellationCalls().length, 2); assert.deepEqual(providerCancelPosts, [{ id: ID }]);
});

test("a lost answer after an initial attempted cancellation supplies no continuation authority", async () => {
  permitOrders(); world.orderState = "resting"; world.cancelOrder = "lose";
  await post(`/app/orders/${ID}/cancel`);
  await post(`/app/orders/${ID}/cancel/continue`); await post(`/app/orders/${ID}/cancel`);
  assert.equal(cancellationCalls().length, 1); assert.deepEqual(providerCancelPosts, [{ id: ID }]);
  assert.equal((await read(`/app/orders/${ID}`)).body.result.value.cancelMayResume, false);
});

test("cancellation continuation rechecks signed-in ownership, capability and current order consent", async () => {
  permitOrders(); world.orderState = "cancel_requested"; world.cancelMayResume = true;
  const endpoint = `/app/orders/${ID}/cancel/continue`;
  assert.equal((await call(endpoint, { method: "POST", body: { organization: ORG, agent: AGENT } })).status, 401);
  assert.equal((await post(endpoint, {}, "intruder.near")).status, 403);
  assert.equal((await call(endpoint, { method: "POST", headers: { ...as(OWNER), origin: "https://elsewhere.test" }, body: { organization: ORG, agent: AGENT } })).status, 403);
  world.capabilities = []; assert.equal((await post(endpoint)).status, 409);
  world.capabilities = ["treasury-limit-orders-v1"]; world.scopes = ["read", "treasury", "treasury-execute"];
  assert.equal((await post(endpoint)).status, 403);
  permitOrders(); world.revoked = true; assert.equal((await post(endpoint)).status, 403);
  world.revoked = false; world.expiresAt = Date.now() - 1; assert.equal((await post(endpoint)).status, 403);
  world.expiresAt = Date.now() + 60_000; world.owner = "next-owner.near"; assert.equal((await post(endpoint)).status, 403);
  assert.deepEqual(orderCalls(), []); assert.deepEqual(providerCancelPosts, []);
});

test("DAO cancellation continuation requires current member proposal and voting rights", async () => {
  dao(); world.orderState = "resting"; world.cancelOrder = "pre_submission";
  await post(`/app/orders/${ID}/cancel`, {}, MEMBER);
  const endpoint = `/app/orders/${ID}/cancel/continue`;
  assert.equal((await post(endpoint, {}, READER)).status, 403);
  assert.equal((await post(endpoint, {}, "outsider.near")).status, 403);
  world.daoPolicy!.roles[0]!.permissions = ["call:AddProposal"];
  assert.equal((await post(endpoint, {}, MEMBER)).status, 403);
  assert.equal(cancellationCalls().length, 1); assert.deepEqual(providerCancelPosts, []);
  world.daoPolicy!.roles[0]!.permissions.push("call:VoteApprove"); world.cancelOrder = "cancel_requested";
  const continued = await post(endpoint, {}, MEMBER);
  assert.equal(continued.body.result.value.cancelMayResume, false);
  assert.deepEqual(cancellationCalls().map(call => call.input), [{ id: ID }, { id: ID }]); assert.deepEqual(providerCancelPosts, [{ id: ID }]);
});

test("refresh retains partial fills, cancellation, failed payout and final payout evidence distinctly", async () => {
  permitOrders();
  world.orderState = "partially_filled"; world.fillStatus = "partially_filled"; world.payoutStatus = "in_progress"; world.isPayoutStatusFinal = false;
  world.partialFills = [{ quantity: "200000000000000000000000", amount: "500000", transaction: "fill-1" }];
  world.payouts = { USDC: { amount: "500000", status: "in_progress" } };
  const partial = (await post(`/app/orders/${ID}/refresh`)).body.result.value;
  assert.equal(partial.state, "partially_filled"); assert.deepEqual(partial.partialFills, world.partialFills); assert.deepEqual(partial.payouts, world.payouts);
  world.orderState = "cancel_requested"; world.fillStatus = "pending_cancel";
  assert.equal((await post(`/app/orders/${ID}/refresh`)).body.result.value.state, "cancel_requested");
  world.orderState = "payout_failed"; world.fillStatus = "filled"; world.payoutStatus = "failed"; world.isPayoutStatusFinal = true;
  assert.equal((await post(`/app/orders/${ID}/refresh`)).body.result.value.state, "payout_failed");
  world.orderState = "unknown"; world.fillStatus = "provider-new-state";
  assert.equal((await post(`/app/orders/${ID}/refresh`)).body.result.value.state, "unknown");
  world.orderState = "completed"; world.fillStatus = "filled"; world.payoutStatus = "completed"; world.isPayoutStatusFinal = true;
  const final = (await post(`/app/orders/${ID}/refresh`)).body.result.value;
  assert.deepEqual([final.state, final.fillStatus, final.payoutStatus, final.isPayoutStatusFinal], ["completed", "filled", "completed", true]);
});

test("order quote/list use the app SDK and browser or outside-agent credentials cannot bypass owner authority", async () => {
  permitOrders();
  assert.equal((await post("/app/orders/quote", terms())).body.result.value.spendAsset, WNEAR);
  assert.equal((await read()).body.result.value.orders.length, 1);
  const { secret } = tokens.issue({ organization: ORG, agent: AGENT, label: "outside", scopes: ["read", "propose"] }, { owner: OWNER, agentId: world.agentId, host: HOST });
  assert.equal((await call(`/app/orders/${ID}/place`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: { organization: ORG, agent: AGENT } })).status, 401);
  assert.equal((await post(`/app/orders/${ID}/place`, {}, "intruder.near")).status, 403);
  assert.equal((await call(`/app/orders/${ID}/place`, { method: "POST", headers: { ...as(OWNER), origin: "https://elsewhere.test" }, body: { organization: ORG, agent: AGENT } })).status, 403);
  world.owner = "next-owner.near";
  assert.equal((await read()).status, 403);
  assert.ok(!reached.includes("limitOrders/place"));
});

test("a DAO uses current Group membership, proposal and voting permissions for its exact order vote", async () => {
  dao();
  const access = (await read("/app/orders/access", MEMBER)).body;
  assert.deepEqual([access.signer, access.mayRead, access.mayPrepare, access.mayExecute, access.mayVote], ["dao", true, true, true, true]);
  assert.equal((await read("/app/orders/access", READER)).body.mayRead, true);
  assert.equal((await post("/app/orders", request(), READER)).status, 403);
  assert.equal((await post(`/app/orders/${ID}/place`, {}, READER)).status, 403);
  assert.equal((await post(`/app/orders/${ID}/dao`, { verdict: "approve" }, READER)).status, 403);
  assert.equal((await post(`/app/orders/${ID}/decide`, { verdict: "approve", signed: signed(limitOrderText(orderView(), "approve")) }, MEMBER)).status, 403,
    "a member never signs as the DAO");
  const filed = await post(`/app/orders/${ID}/dao`, { verdict: "approve" }, MEMBER);
  assert.equal(filed.body.result.value.request.order, ID);
  assert.deepEqual(calls.find(c => c.path === "daoLimitOrders/file")!.input, { organization: ORG, agent: AGENT, order: ID, verdict: "approve" });
  const pending = await read(`/app/orders/dao/${DAO_ORDER_HASH}`, MEMBER);
  assert.equal(pending.body.result.value.state, "pending");
  world.daoOrderState = "relayed";
  assert.equal((await read(`/app/orders/dao/${DAO_ORDER_HASH}`, MEMBER)).body.result.value.orderState, "approved");
  world.daoPolicy!.roles[0]!.kind = { Group: [] };
  const polledBefore = reached.filter(path => path === "daoLimitOrders/state").length;
  assert.equal((await read(`/app/orders/dao/${DAO_ORDER_HASH}`, MEMBER)).status, 403);
  assert.equal(reached.filter(path => path === "daoLimitOrders/state").length, polledBefore, "membership is reread before a poll can relay a vote");
});

test("Everyone permissions do not admit a nonmember and changed voting rights remove execution controls", async () => {
  dao(); world.daoPolicy!.roles[2]!.permissions = ["*:*", "call:AddProposal", "call:VoteApprove"];
  assert.equal((await read("/app/orders/access", "outsider.near")).status, 403);
  world.daoPolicy!.roles[2]!.permissions = [];
  world.daoPolicy!.roles[0]!.permissions = ["call:AddProposal"];
  const access = (await read("/app/orders/access", MEMBER)).body;
  assert.deepEqual([access.mayPrepare, access.mayExecute, access.mayVote], [true, false, false]);
  assert.equal((await post(`/app/orders/${ID}/place`, {}, MEMBER)).status, 403);
  assert.equal((await post(`/app/orders/${ID}/cancel`, {}, MEMBER)).status, 403);
  world.daoPolicy = null;
  assert.ok([403, 503].includes((await read("/app/orders/access", MEMBER)).status), "unavailable policy supplies no authority");
});

test("DAO polling rejects an unbound hash and a different tuple before any relay", async () => {
  dao();
  const unbound = await read(`/app/orders/dao/${DAO_ORDER_HASH}`, MEMBER);
  assert.ok(unbound.status >= 400 || !unbound.body.result?.ok);
  assert.ok(!reached.includes("daoLimitOrders/state"));
  await post(`/app/orders/${ID}/dao`, { verdict: "approve" }, MEMBER);
  const before = reached.filter(path => path === "daoLimitOrders/state").length;
  const foreign = await call(`/app/orders/dao/${DAO_ORDER_HASH}?organization=other&agent=${AGENT}`, { headers: as(MEMBER) });
  assert.ok(foreign.status >= 400 || !foreign.body.result?.ok);
  assert.equal(reached.filter(path => path === "daoLimitOrders/state").length, before);
});

test("DAO state with changed order terms is never shown as a successful relay", async () => {
  dao();
  await post(`/app/orders/${ID}/dao`, { verdict: "approve" }, MEMBER);
  world.daoOrderState = "relayed";
  world.daoRequestOverride = { order: "e".repeat(32) };
  const result = await read(`/app/orders/dao/${DAO_ORDER_HASH}`, MEMBER);
  assert.equal(result.body.result.ok, false);
  assert.equal(result.body.result.code, "dao_request_mismatch");
});

test("a DAO connected under old Treasury consent can file and follow a distinct orders-consent vote", async () => {
  dao(); world.scopes = ["read", "treasury"];
  const access = (await read("/app/orders/access", MEMBER)).body;
  assert.deepEqual([access.consented, access.mayConsent], [false, true]);
  const filed = await post("/app/orders/consent", { days: 7 }, MEMBER);
  assert.equal(filed.body.result.ok, true);
  const parsed = JSON.parse(filed.body.message);
  assert.deepEqual(parsed.scopes, ["read", "treasury", "treasury-orders"]);
  assert.equal(filed.body.message, consentMessage({ host: PLATFORM_HOST, deployment: "treasury-app", organization: ORG,
    owner: DAO, agent: AGENT, agentId: world.agentId, scopes: ["read", "treasury", "treasury-orders"], expiresAt: parsed.expiresAt }));
  assert.deepEqual(calls.find(c => c.path === "daoConsents/file")!.input, { message: filed.body.message });
  assert.equal((await read(`/app/orders/consent/${DAO_CONSENT_HASH}`, MEMBER)).body.result.value.state, "pending");
  world.daoConsentState = "signed";
  const granted = await read(`/app/orders/consent/${DAO_CONSENT_HASH}`, MEMBER);
  assert.equal(granted.body.result.value.state, "signed");
  assert.deepEqual(granted.body.result.value.consent.scopes, ["read", "treasury", "treasury-orders"]);
  assert.equal((await read("/app/orders/access", MEMBER)).body.consented, true);
});

test("DAO order consent filing and polling require current proposal membership and the saved identity", async () => {
  dao(); world.scopes = ["read", "treasury"];
  assert.equal((await post("/app/orders/consent", {}, READER)).status, 403);
  assert.equal((await post("/app/orders/consent", {}, "outsider.near")).status, 403);
  assert.equal((await read(`/app/orders/consent/${DAO_CONSENT_HASH}`, MEMBER)).status, 404);
  assert.ok(!reached.includes("daoConsents/state"));
  assert.equal((await post("/app/orders/consent", { days: 0 }, MEMBER)).status, 400);
  await post("/app/orders/consent", {}, MEMBER);
  const before = reached.filter(path => path === "daoConsents/state").length;
  world.agentId = "replacement-agent"; world.consentFollows = true;
  assert.equal((await read(`/app/orders/consent/${DAO_CONSENT_HASH}`, MEMBER)).status, 404);
  assert.equal(reached.filter(path => path === "daoConsents/state").length, before);
  world.agentId = "agent-1"; world.daoPolicy!.roles[0]!.permissions = [];
  assert.equal((await read(`/app/orders/consent/${DAO_CONSENT_HASH}`, MEMBER)).status, 403);
  assert.equal(reached.filter(path => path === "daoConsents/state").length, before);
});
