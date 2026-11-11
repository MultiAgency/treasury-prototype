import assert from "node:assert/strict";
import fs, { fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeTokens } from "../app/runtime-tokens.js";
import { EXIT } from "../app/treasury-app.js";
import { AGENT, appPlatform, HOST, ID, ORG, OWNER, USDC, WNEAR } from "./fixtures/app-platform.js";

// Agents' tokens on the Treasury app's server, in front of a fixture platform (test/fixtures/app-platform.ts).
const { world, reached, state, tokens, call, as } = appPlatform("app-runtime");
const issue = (scopes: string[], account = OWNER, extra = {}) =>
  call("/app/tokens", { method: "POST", headers: as(account), body: { organization: ORG, agent: AGENT, label: "assistant", scopes, ttlSeconds: 3_600, ...extra } });
const run = (secret: string, command: string, body: unknown = {}, { org = ORG, agent = AGENT, headers = {} }: { org?: string; agent?: string; headers?: Record<string, string> } = {}) =>
  call(`/runtime/v1/o/${org}/a/${agent}/${command}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, ...headers }, body });
const proposal = { requestId: "req-1", legs: [{ from: USDC, to: WNEAR, amount: "1000000" }], expiresAt: "2026-11-05T00:00:00Z" };

test("first token issue syncs the new token directory entry before returning its secret", () => {
  const parent = mkdtempSync(join(tmpdir(), "treasury-token-durable-")), state = join(parent, "app");
  mkdirSync(state, { mode: 0o700 });
  let stateSynced = false, stateSyncedBeforeRecord = false;
  const originalSync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    const target = fstatSync(fd), app = statSync(state);
    if (target.dev === app.dev && target.ino === app.ino) stateSynced = true;
    if (target.isFile()) stateSyncedBeforeRecord = stateSynced;
    return originalSync(fd);
  };
  syncBuiltinESMExports();
  try {
    const issued = new RuntimeTokens(join(state, "tokens")).issue(
      { organization: ORG, agent: AGENT, label: "durable", scopes: ["read"], ttlSeconds: 3_600 },
      { owner: OWNER, agentId: "agent-1", host: HOST });
    assert.match(issued.secret, /^tat_/);
    assert.equal(stateSyncedBeforeRecord, true, "APP_STATE must be synced before the first token record is written");
  } finally {
    fs.fsyncSync = originalSync;
    syncBuiltinESMExports();
  }
});

test("the owner issues a read+propose token; the agent reads and proposes, and the secret is stored only as a hash", async () => {
  const issued = await issue(["read", "propose"]);
  assert.equal(issued.status, 201);
  const { secret, token } = issued.body;
  assert.match(secret, /^tat_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([token.owner, token.organization, token.agent, token.agentId, token.host], [OWNER, ORG, AGENT, "agent-1", HOST]);
  for (const file of readdirSync(join(state, "tokens"))) assert.ok(!readFileSync(join(state, "tokens", file), "utf8").includes(secret.split(".")[1]), "no secret on disk");
  for (const [command, body, value] of [["unresolved", {}, []], ["proposal", { id: ID }, "proposed"], ["proposals", {}, 1], ["propose", proposal, "proposed"], ["withdraw", { id: ID }, "withdrawn"]] as const) {
    const answer = await run(secret, command, body);
    assert.equal(answer.status, 200, command);
    assert.equal(answer.body.exit, EXIT.ok, command);
    const got = answer.body.result.value;
    assert.deepEqual(Array.isArray(value) ? got : typeof value === "number" ? got.proposals.length : got.state, value, command);
  }
  assert.deepEqual(reached, ["unresolved", "proposals/get", "proposals/list", "proposals/create", "proposals/withdraw"]);
  const listed = await call(`/app/tokens?organization=${ORG}&agent=${AGENT}`, { headers: as(OWNER) });
  assert.deepEqual(listed.body.tokens.map((t: { id: string }) => t.id), [token.id]);
  assert.ok(!JSON.stringify(listed.body).includes("secretHash"));
});

test("no command executes anything: execute and plan routes don't exist for an agent's token", async () => {
  const { secret } = (await issue(["read", "propose"])).body;
  for (const command of ["execute", "executePlan", "approve", "sweep", "rebalance"]) assert.equal((await run(secret, command, { id: ID })).status, 404, command);
  assert.deepEqual(reached, []);
});

test("each token reaches only its scopes, its own agent and Organization, and this host, without browser credentials", async () => {
  const read = (await issue(["read"])).body.secret, propose = (await issue(["propose"])).body.secret;
  assert.equal((await run(read, "propose", proposal)).status, 403);
  assert.equal((await run(read, "withdraw", { id: ID })).status, 403);
  assert.equal((await run(propose, "unresolved")).status, 403);
  assert.equal((await run(read, "unresolved", {}, { org: "org_2" })).status, 403);
  assert.equal((await run(read, "unresolved", {}, { agent: "other" })).status, 403);
  assert.equal((await run(read, "unresolved", {}, { headers: { host: "elsewhere.test" } })).status, 421);
  assert.equal((await run(read, "unresolved", {}, { headers: { cookie: as(OWNER).cookie } })).status, 403);
  assert.equal((await run(read, "unresolved", {}, { headers: { origin: `https://${HOST}` } })).status, 403);
  assert.equal((await run(read + "x", "unresolved")).status, 401);
  assert.deepEqual(reached, []);
});

test("only the agent's current owner, with a live consent covering the scopes, issues a token", async () => {
  assert.equal((await call("/app/tokens", { method: "POST", body: {} })).status, 401);
  assert.equal((await issue(["read"], "someone.near")).status, 403);
  world.scopes = ["read"];
  assert.equal((await issue(["read", "propose"])).status, 403, "propose needs the treasury consent");
  assert.equal((await issue(["read"])).status, 201);
  world.revoked = true;
  assert.equal((await issue(["read"])).status, 403, "a revoked consent covers nothing");
  world.revoked = false; world.expiresAt = Date.now() - 1;
  assert.equal((await issue(["read"])).status, 403, "an expired consent covers nothing");
  world.expiresAt = Date.now() + 86_400_000; world.down = true;
  assert.equal((await issue(["read"])).status, 503);
  world.down = false;
  assert.equal((await issue(["read", "execute"])).status, 400);
  assert.equal((await issue(["read"], OWNER, { ttlSeconds: 86_401 })).status, 400);
});

test("every call re-checks the platform: a changed owner, agent or consent refuses, and an outage sends nothing", async () => {
  const { secret } = (await issue(["read", "propose"])).body;
  world.owner = "new-owner.near";
  assert.equal((await run(secret, "unresolved")).status, 403);
  world.owner = OWNER; world.agentId = "agent-2";
  assert.equal((await run(secret, "unresolved")).status, 403);
  // Even when the new owner or the new agent identity has consented too, the old owner's token stays refused.
  world.consentFollows = true; world.owner = "new-owner.near"; world.agentId = "agent-1";
  assert.equal((await run(secret, "unresolved")).status, 403, "a token is the issuing owner's, never the next owner's");
  world.owner = OWNER; world.agentId = "agent-2";
  assert.equal((await run(secret, "unresolved")).status, 403, "a token is bound to the agent identity it was issued for");
  world.consentFollows = false; world.agentId = "agent-1"; world.scopes = ["read"];
  assert.equal((await run(secret, "propose", proposal)).status, 403, "the consent no longer covers proposals");
  assert.equal((await run(secret, "unresolved")).status, 200);
  world.scopes = ["read", "treasury"]; world.revoked = true;
  assert.equal((await run(secret, "unresolved")).status, 403);
  world.revoked = false; world.down = true;
  const out = await run(secret, "propose", proposal);
  assert.deepEqual([out.status, out.body.exit], [503, EXIT.notSent]);
  assert.deepEqual(reached, ["unresolved"]);
});

test("revocation is immediate and only the issuing owner revokes; an expired token authenticates nothing", async () => {
  const { secret, token } = (await issue(["read"])).body;
  assert.equal((await call(`/app/tokens/${token.id}`, { method: "DELETE", headers: as("someone.near") })).status, 404);
  assert.equal((await run(secret, "unresolved")).status, 200);
  assert.equal((await call(`/app/tokens/${token.id}`, { method: "DELETE", headers: as(OWNER) })).status, 200);
  assert.equal((await run(secret, "unresolved")).status, 401);
  const short = (await issue(["read"], OWNER, { ttlSeconds: 60 })).body.secret;
  assert.ok(tokens.authenticate(`Bearer ${short}`, HOST));
  assert.equal(tokens.authenticate(`Bearer ${short}`, HOST, Date.now() + 61_000), null);
  assert.equal(tokens.authenticate(`Bearer ${short}`, "elsewhere.test"), null);
});

test("a consent in another Organization covers nothing here, whatever the platform lists", async () => {
  const issued = await call("/app/tokens", { method: "POST", headers: as(OWNER), body: { organization: "org_2", agent: AGENT, label: "x", scopes: ["read"], ttlSeconds: 3_600 } });
  assert.equal(issued.status, 403);
});

test("a damaged token record authorizes nothing and doesn't hide the owner's other tokens", async () => {
  const good = (await issue(["read"])).body, damaged = (await issue(["read"])).body;
  writeFileSync(join(state, "tokens", `${damaged.token.id}.json`), "{ not json");
  writeFileSync(join(state, "tokens", "00000000-0000-4000-8000-000000000000.json"), JSON.stringify({ version: 1, id: "wrong" }));
  assert.equal((await run(damaged.secret, "unresolved")).status, 401, "fails closed");
  const listed = await call(`/app/tokens?organization=${ORG}&agent=${AGENT}`, { headers: as(OWNER) });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.tokens.some((t: { id: string }) => t.id === good.token.id));
  assert.equal((await run(good.secret, "unresolved")).status, 200);
});

test("a malformed Organization in the path is a usage mistake with an exit code", async () => {
  const { secret } = (await issue(["read"])).body;
  const answer = await call("/runtime/v1/o/%E0%A4/a/portfolio/unresolved", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: {} });
  assert.deepEqual([answer.status, answer.body.exit], [400, EXIT.notSent]);
});
