import assert from "node:assert/strict";
import { test } from "node:test";
import { proposalText } from "@multiagency/sdk";
import { EXIT } from "../app/treasury-app.js";
import { AGENT, appPlatform, HOST, ID, ORG, OWNER, PLATFORM_HOST } from "./fixtures/app-platform.js";

// The owner's proposals on the Treasury app's server, in front of a fixture platform (test/fixtures/app-platform.ts).
const { world, calls, reached, view, call, as, tokens } = appPlatform("app-approval");
const where = `organization=${ORG}&agent=${AGENT}`;
const signed = (message: string) => ({ message, nonce: Buffer.alloc(32, 7).toString("base64"), publicKey: "ed25519:11111111111111111111111111111111", signature: "ed25519:fixture-signature" });
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
  const approved = await decide("approve", approve);
  assert.deepEqual([approved.body.exit, approved.body.result.value.state], [EXIT.ok, "approved"]);
  assert.deepEqual(calls.find(c => c.path === "proposals/approve")!.input, { id: ID, signed: signed(approve) });
  const rejected = await decide("reject", reject);
  assert.equal(rejected.body.result.value.state, "rejected");
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
