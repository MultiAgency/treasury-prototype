import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { proposalText } from "@multiagency/sdk";
import { EXIT } from "../app/treasury-app.js";
import { AGENT, appPlatform, HOST, ID, ORG, OWNER, PLATFORM_HOST } from "./fixtures/app-platform.js";

// The owner's proposals on the Treasury app's server, in front of a fixture platform (test/fixtures/app-platform.ts).
const { world, calls, reached, view, call, as, tokens, port } = appPlatform("app-approval");
const where = `organization=${ORG}&agent=${AGENT}`;
const signed = (message: string, nonce = 7) => ({ message, nonce: Buffer.alloc(32, nonce).toString("base64"), publicKey: "ed25519:11111111111111111111111111111111", signature: "ed25519:fixture-signature" });
const decide = (verdict: string, message: string, account = OWNER) =>
  call(`/app/proposals/${ID}/decide`, { method: "POST", headers: as(account), body: { organization: ORG, agent: AGENT, verdict, signed: signed(message) } });
const execute = (account = OWNER) => call(`/app/proposals/${ID}/execute`, { method: "POST", headers: as(account), body: { organization: ORG, agent: AGENT } });

test("the owner reads a proposal with the platform's exact texts to sign, and the platform host as recipient", async () => {
  const read = await call(`/app/proposals/${ID}?${where}`, { headers: as(OWNER) });
  assert.equal(read.status, 200);
  assert.equal(read.body.result.value.state, "proposed");
  assert.deepEqual(read.body.sign, { recipient: PLATFORM_HOST, approve: proposalText(view("proposed"), "approve"), reject: proposalText(view("proposed"), "reject") });
  const listed = await call(`/app/proposals?${where}`, { headers: as(OWNER) });
  assert.deepEqual([listed.body.exit, listed.body.result.value.proposals.length], [EXIT.ok, 1]);
});

test("a signed decision is relayed only over the platform's exact text for that verdict", async () => {
  const approve = proposalText(view("proposed"), "approve"), reject = proposalText(view("proposed"), "reject");
  for (const [verdict, message] of [["approve", reject], ["reject", approve], ["approve", approve.replace("Approve", "approve")]] as const) {
    const refused = await decide(verdict, message);
    assert.deepEqual([refused.body.exit, refused.body.result.code], [EXIT.notSent, "signature_text_mismatch"], `${verdict}: ${message.slice(0, 30)}`);
  }
  assert.ok(!reached.some(path => path === "proposals/approve" || path === "proposals/reject"));
  const approved = await call(`/app/proposals/${ID}/decide`, { method: "POST", headers: as(OWNER),
    body: { organization: ORG, agent: AGENT, verdict: "approve", signed: signed(approve, 8) } });
  assert.deepEqual([approved.body.exit, approved.body.result.value.state], [EXIT.ok, "approved"]);
  assert.deepEqual(calls.find(c => c.path === "proposals/approve")!.input, { id: ID, signed: signed(approve, 8) });
  const repeated = await decide("reject", reject);
  assert.deepEqual([repeated.body.exit, repeated.body.decisionHeld], [EXIT.unknown, true]);
  assert.equal(reached.filter(path => path === "proposals/reject").length, 0, "an opposite decision cannot replay an attempted signature");
  assert.equal((await call(`/app/proposals/${ID}/decide`, { method: "POST", headers: as(OWNER), body: { organization: ORG, agent: AGENT, verdict: "approve" } })).status, 400);
});

test("the owner's Execute makes one attempt, reads a lost answer back, and exits by outcome", async () => {
  world.proposalState = "approved";
  assert.deepEqual([(await execute()).body.exit, reached.filter(p => p === "proposals/execute").length], [EXIT.ok, 1]);
  reached.length = 0; world.execute = "lose"; world.proposalState = "unknown";
  const lost = await execute();
  assert.deepEqual([lost.body.exit, lost.body.result.value.state], [EXIT.unknown, "unknown"]);
  assert.deepEqual(reached.filter(p => p.startsWith("proposals/")), ["proposals/execute", "proposals/get"], "never a second execute");
  world.execute = "not_executable";
  const refused = await execute();
  assert.deepEqual([refused.body.exit, refused.body.result.code], [EXIT.notSent, "not_executable"]);
});

test("only the agent's current owner, signed in, under a live treasury consent, reaches proposals", async () => {
  const paths = [() => call(`/app/proposals/${ID}?${where}`, { headers: as("someone.near") }), () => execute("someone.near"),
    () => decide("approve", proposalText(view("proposed"), "approve"), "someone.near")];
  for (const attempt of paths) assert.equal((await attempt()).status, 403);
  assert.equal((await call(`/app/proposals/${ID}/execute`, { method: "POST", body: { organization: ORG, agent: AGENT } })).status, 401);
  world.scopes = ["read"];
  assert.equal((await execute()).status, 403, "a read-only consent reaches no proposal");
  world.scopes = ["read", "treasury"]; world.owner = "new-owner.near";
  assert.equal((await execute()).status, 403, "the previous owner's session is refused once the agent changes hands");
  world.owner = OWNER; world.down = true;
  assert.deepEqual([(await execute()).status, (await execute()).body.exit], [503, EXIT.notSent]);
  assert.deepEqual(reached, []);
});

test("an agent's token or a cross-site page can't reach the owner's proposals", async () => {
  const { secret } = tokens.issue({ organization: ORG, agent: AGENT, label: "assistant", scopes: ["read", "propose"] }, { owner: OWNER, agentId: "agent-1", host: HOST });
  assert.equal((await call(`/app/proposals/${ID}/execute`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: { organization: ORG, agent: AGENT } })).status, 401);
  assert.equal((await call(`/app/proposals/${ID}/execute`, { method: "POST", headers: { ...as(OWNER), origin: "https://elsewhere.test" }, body: { organization: ORG, agent: AGENT } })).status, 403);
  assert.equal((await call(`/app/proposals/${ID}/execute?${where}`, { headers: as(OWNER) })).status, 405, "execute is a POST");
  assert.deepEqual(reached, []);
});


test("a pending proposal decision closes signing before a racing proposed read completes", async () => {
  let release!: () => void;
  world.proposalDecisionGate = new Promise<void>(done => { release = done; });
  const pending = decide("approve", proposalText(view("proposed"), "approve"));
  try {
    for (let i = 0; i < 200 && !reached.includes("proposals/approve"); i++) await new Promise<void>(done => setTimeout(done, 5));
    assert.ok(reached.includes("proposals/approve"));
    const during = await call(`/app/proposals/${ID}?${where}`, { headers: as(OWNER) });
    assert.equal(during.body.result.value.state, "proposed");
    assert.equal(during.body.decisionHeld, true);
    assert.equal(during.body.sign, undefined, "a proposed read cannot rule out the pending approval");
    for (const verdict of ["approve", "reject"] as const) {
      const repeated = await decide(verdict, proposalText(view("proposed"), verdict));
      assert.deepEqual([repeated.body.exit, repeated.body.decisionHeld], [EXIT.unknown, true]);
    }
    assert.equal(reached.filter(path => path === "proposals/approve" || path === "proposals/reject").length, 1);
  } finally { release(); }
  assert.equal((await pending).body.result.value.state, "approved");
});

test("a lost proposal decision reply stays held even when a later read is proposed", async () => {
  world.proposalDecision = "lose";
  const answer = await decide("approve", proposalText(view("proposed"), "approve"));
  assert.deepEqual([answer.body.exit, answer.body.decisionHeld], [EXIT.unknown, true]);
  world.proposalState = "proposed";
  const read = await call(`/app/proposals/${ID}?${where}`, { headers: as(OWNER) });
  assert.equal(read.body.decisionHeld, true); assert.equal(read.body.sign, undefined);
  await decide("reject", proposalText(view("proposed"), "reject"));
  assert.equal(reached.filter(path => path === "proposals/approve" || path === "proposals/reject").length, 1);
});

test("a plain HTTP400 after recording a proposal decision never proves it was refused", async () => {
  world.proposalDecision = "plain-400";
  const answer = await decide("approve", proposalText(view("proposed"), "approve"));
  assert.deepEqual([answer.body.exit, answer.body.decisionHeld], [EXIT.unknown, true]);
  world.proposalState = "proposed";
  const read = await call(`/app/proposals/${ID}?${where}`, { headers: as(OWNER) });
  assert.equal(read.body.decisionHeld, true); assert.equal(read.body.sign, undefined);
});

test("only a definitive proposal refusal permits a fresh signature, never replay of the old signed body", async () => {
  world.proposalDecision = "refuse";
  const message = proposalText(view("proposed"), "approve");
  const refused = await decide("approve", message);
  assert.deepEqual([refused.body.exit, refused.body.decisionHeld, refused.body.result.code], [EXIT.notSent, false, "signature_refused"]);
  const read = await call(`/app/proposals/${ID}?${where}`, { headers: as(OWNER) });
  assert.equal(read.body.decisionHeld, false); assert.ok(read.body.sign);
  world.proposalDecision = "normal";
  const replay = await decide("approve", message);
  assert.equal(replay.body.result.code, "decision_already_attempted");
  const fresh = await call(`/app/proposals/${ID}/decide`, { method: "POST", headers: as(OWNER),
    body: { organization: ORG, agent: AGENT, verdict: "approve", signed: signed(message, 8) } });
  assert.deepEqual([fresh.body.exit, fresh.body.decisionHeld, fresh.body.result.value.state], [EXIT.ok, true, "approved"]);
  assert.equal(reached.filter(path => path === "proposals/approve").length, 2);
});

test("a first rejection is recorded once and cannot later be replaced with approval", async () => {
  assert.equal((await decide("reject", proposalText(view("proposed"), "reject"))).body.result.value.state, "rejected");
  assert.equal((await decide("approve", proposalText(view("proposed"), "approve"))).body.exit, EXIT.unknown);
  assert.equal(reached.filter(path => path === "proposals/reject").length, 1);
  assert.equal(reached.filter(path => path === "proposals/approve").length, 0);
});


test("an admitted proposal decision holds other devices while its initial exact-text read is delayed", async () => {
  let release!: () => void;
  world.proposalDecisionReadGate = new Promise<void>(done => { release = done; });
  const pending = decide("approve", proposalText(view("proposed"), "approve"));
  try {
    for (let i = 0; i < 200 && !reached.includes("proposals/get"); i++) await new Promise<void>(done => setTimeout(done, 5));
    assert.ok(reached.includes("proposals/get"));
    const otherDevice = await call(`/app/proposals/${ID}?${where}`, { headers: as(OWNER) });
    assert.equal(otherDevice.body.result.value.state, "proposed");
    assert.equal(otherDevice.body.decisionHeld, true); assert.equal(otherDevice.body.sign, undefined);
    assert.equal((await decide("reject", proposalText(view("proposed"), "reject"))).body.exit, EXIT.unknown);
    assert.equal(reached.filter(path => path === "proposals/approve" || path === "proposals/reject").length, 0,
      "the durable hold precedes the approval's preliminary platform read");
  } finally { release(); }
  assert.equal((await pending).body.result.value.state, "approved");
});

test("a dropped definitive-refusal HTTP reply retains evidence and never permits exact signed-body replay", async () => {
  world.proposalDecision = "refuse";
  const message = proposalText(view("proposed"), "approve");
  await new Promise<void>((done, fail) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: port(), path: `/app/proposals/${ID}/decide`, method: "POST",
      headers: { host: HOST, "content-type": "application/json", ...as(OWNER) } }, response => {
      // Headers arrived, but the owner never receives the decision answer body.
      response.destroy(); done();
    });
    req.once("error", fail); req.setTimeout(3_000, () => req.destroy(new Error("Fixture decision timed out")));
    req.end(JSON.stringify({ organization: ORG, agent: AGENT, verdict: "approve", signed: signed(message) }));
  });
  const read = await call(`/app/proposals/${ID}?${where}`, { headers: as(OWNER) });
  assert.equal(read.body.result.value.state, "proposed"); assert.equal(read.body.decisionHeld, false);
  assert.ok(read.body.sign, "the server has definitive refusal evidence; this alone does not clear the original browser's uncertain marker");
  const repeated = await decide("approve", message);
  assert.equal(repeated.body.result.code, "decision_already_attempted");
  assert.equal(reached.filter(path => path === "proposals/approve").length, 1);
});
