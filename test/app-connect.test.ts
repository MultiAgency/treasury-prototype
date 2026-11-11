import assert from "node:assert/strict";
import { test } from "node:test";
import { consentMessage } from "@multiagency/sdk";
import { CONSENT_SIGNING_MS, MAX_PENDING_PER_OWNER } from "../app/server.js";
import { AGENT, appPlatform, ORG, OWNER, PLATFORM_HOST } from "./fixtures/app-platform.js";

// Connecting an agent to the Treasury app, in front of a fixture platform (test/fixtures/app-platform.ts).
const { world, submissions, revocations, call, as } = appPlatform("app-connect");
const KEY = "ed25519:11111111111111111111111111111111";
const prepare = (extra: object = {}, account = OWNER) => call("/app/connect/prepare", { method: "POST", headers: as(account), body: { organization: ORG, agent: AGENT, ...extra } });
const submit = (nonce: string, account = OWNER) => call("/app/connect", { method: "POST", headers: as(account), body: { nonce, publicKey: KEY, signature: "ed25519:fixture-signature" } });
const expected = (scopes: string[], expiresAt: string) => consentMessage({ host: PLATFORM_HOST, deployment: "treasury-app", organization: ORG, owner: OWNER, agent: AGENT,
  agentId: "agent-1", scopes: scopes as never, expiresAt });

test("the owner is given the SDK's consent text for read and treasury, for the platform host, with a fresh nonce", async () => {
  const before = Date.now(), prepared = (await prepare()).body;
  assert.deepEqual(prepared.scopes, ["read", "treasury"]);
  assert.equal(prepared.recipient, PLATFORM_HOST);
  assert.equal(Buffer.from(prepared.nonce, "base64").length, 32);
  const expiresAt = JSON.parse(prepared.message).expiresAt;
  assert.ok(Math.abs(Date.parse(expiresAt) - (before + 30 * 86_400_000)) < 5_000, "30 days by default");
  assert.equal(prepared.message, expected(["read", "treasury"], expiresAt), "exactly the SDK's canonical text");
  const unattended = (await prepare({ execute: true, days: 7 })).body;
  assert.deepEqual(unattended.scopes, ["read", "treasury", "treasury-execute"], "unattended execution only when asked");
  assert.notEqual(unattended.nonce, prepared.nonce);
  for (const bad of [{ days: 0 }, { days: 91 }, { days: 1.5 }, { execute: "yes" }, { agent: "Not An Agent" }]) assert.equal((await prepare(bad)).status, 400, JSON.stringify(bad));
});

test("only the agent's current owner, signed in, connects a created agent; an outage prepares nothing", async () => {
  assert.equal((await call("/app/connect/prepare", { method: "POST", body: { organization: ORG, agent: AGENT } })).status, 401);
  assert.equal((await prepare({}, "someone.near")).status, 403);
  world.created = false;
  assert.equal((await prepare()).status, 409);
  world.created = true; world.down = true;
  assert.equal((await prepare()).status, 503);
});

test("only a text this app prepared is submitted, once, for the owner it was prepared for, while it is fresh", async () => {
  const { nonce, message } = (await prepare()).body;
  assert.equal((await submit(nonce, "someone.near")).status, 409, "another account can't use this owner's prepared consent");
  assert.equal((await submit(Buffer.alloc(32, 9).toString("base64"))).status, 409, "a text not prepared here is never submitted");
  const stored = await submit(nonce);
  assert.equal(stored.status, 201);
  assert.deepEqual(submissions, [{ message, nonce, publicKey: KEY, signature: "ed25519:fixture-signature" }], "exactly the prepared text with the wallet's signature");
  assert.equal((await submit(nonce)).status, 409, "a prepared consent is submitted once");
  const late = (await prepare()).body.nonce, now = Date.now;
  Date.now = () => now() + CONSENT_SIGNING_MS + 1;
  try { assert.equal((await submit(late)).status, 409, "an unsigned text expires"); } finally { Date.now = now; }
  assert.equal(submissions.length, 1);
});

test("with no answer the identical signed body is resent once, and can be submitted again later", async () => {
  const { nonce } = (await prepare()).body;
  world.loseSubmissions = 1;
  assert.equal((await submit(nonce)).status, 201);
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[1], submissions[0], "the same signed body, which the platform treats as the same consent");
  const again = (await prepare()).body.nonce;
  world.loseSubmissions = 2;
  assert.equal((await submit(again)).status, 503);
  assert.equal((await submit(again)).status, 201, "kept after no answer: the same signature can be sent again");
  assert.deepEqual(submissions.slice(2).map(s => JSON.stringify(s)), Array(3).fill(JSON.stringify(submissions[2])));
});

test("the owner lists the agent's consents and revokes one; nobody else can", async () => {
  const listed = await call(`/app/connect?organization=${ORG}&agent=${AGENT}`, { headers: as(OWNER) });
  assert.deepEqual(listed.body.consents.map((c: { id: string }) => c.id), ["d".repeat(64)]);
  assert.equal((await call(`/app/connect?organization=${ORG}&agent=${AGENT}`, { headers: as("someone.near") })).status, 403);
  assert.equal((await call(`/app/connect/${"d".repeat(64)}?organization=${ORG}&agent=${AGENT}`, { method: "DELETE", headers: as("someone.near") })).status, 403);
  assert.equal((await call(`/app/connect/${"f".repeat(64)}?organization=${ORG}&agent=${AGENT}`, { method: "DELETE", headers: as(OWNER) })).status, 404);
  assert.deepEqual(revocations, []);
  assert.equal((await call(`/app/connect/${"d".repeat(64)}?organization=${ORG}&agent=${AGENT}`, { method: "DELETE", headers: as(OWNER) })).status, 200);
  assert.deepEqual(revocations, ["d".repeat(64)]);
});

test("one owner can keep only a few consents waiting, and doesn't block other owners", async () => {
  const waiting = [];
  for (let i = 0; i < MAX_PENDING_PER_OWNER; i++) waiting.push((await prepare()).body.nonce);
  assert.equal((await prepare()).status, 429);
  assert.equal((await submit(waiting[0])).status, 201, "signing one frees its place");
  assert.equal((await prepare()).status, 200);
  world.owner = "second.near";
  assert.equal((await prepare({}, "second.near")).status, 200, "another owner is not crowded out");
});
