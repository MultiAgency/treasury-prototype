import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { proposalText, type ProposalView } from "@multiagency/sdk";
import { writeDurable } from "../app/durable.js";
import { EXIT, commandExit, executionExit, requestFile, treasuryApp } from "../app/treasury-app.js";

// An in-process stand-in for the platform's /apps/v1 Treasury procedures: answers pass through the SDK's own schemas
// and oRPC's encoder. No socket, credential, signature or funds.
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", WNEAR = "nep141:wrap.near";
const BASE = "/apps/v1/o/org_1/a/portfolio/rpc";
const ID = "7d3c1f0e2b4a4c5d8e6f1a2b3c4d5e6f";

function view(state: ProposalView["state"], operations: ProposalView["operations"] = []): ProposalView {
  return { id: ID, requestId: "req-1", agentId: "agent-fixture", deployment: "treasury-app", organization: "org_1", source: "external",
    legs: [{ from: USDC, to: WNEAR, amount: "1000000", minAmountOut: "490000000000000000000000" }],
    quoted: [{ amountOut: "500000000000000000000000", costBps: 5, usdIn: 1 }], policyRevision: 3, policyDigest: "a".repeat(64),
    strategyDigest: `sha256:${"b".repeat(64)}`, createdAt: "2026-11-03T00:00:00.000Z", expiresAt: "2026-11-05T00:00:00.000Z",
    note: null, sha256: "c".repeat(64), state, reason: null, approvedAt: state === "proposed" ? null : "2026-11-03T01:00:00.000Z",
    planId: null, operations };
}
const refusal = (code: string) => new ORPCError("BAD_REQUEST", { message: code, data: { kind: "refused", code } });

function platform(script: { create?: "lose-first" | "refuse-first"; execute?: ProposalView | "lose" | "not_executable"; read?: ProposalView; state?: string; approve?: "plain-400" | "lose" | "refuse"; decisionGate?: Promise<void> } = {}) {
  const calls: { path: string; input: unknown }[] = [];
  let creates = 0;
  const record = (path: string) => ({ input }: { input: unknown }) => { calls.push({ path, input }); };
  const handler = new RPCHandler({ proposals: {
    create: os.handler(async ({ input }) => {
      record("create")({ input });
      if (script.state) assert.ok(readdirSync(join(script.state, "requests")).length > 0, "the request is recorded before the platform sees it");
      creates++;
      if (script.create === "refuse-first" && creates === 1) throw refusal("not_proposable");
      return view("proposed");
    }),
    get: os.handler(async ({ input }) => { record("get")({ input }); return script.read ?? view("approved"); }),
    approve: os.handler(async ({ input }) => {
      record("approve")({ input }); await script.decisionGate;
      if (script.approve === "refuse") throw refusal("signature_refused");
      return view("approved");
    }),
    reject: os.handler(async ({ input }) => { record("reject")({ input }); return view("rejected"); }),
    execute: os.handler(async ({ input }) => {
      record("execute")({ input });
      if (script.execute === "not_executable") throw refusal("not_executable");
      return script.execute === "lose" || script.execute === undefined ? view("executed") : script.execute;
    }),
  } });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get("authorization"), "Bearer tap_fixture");
    // Any Organization and agent: /apps/v1/o/<org>/a/<agent>/rpc.
    const { matched, response } = await handler.handle(request, { prefix: new URL(request.url).pathname.replace(/\/rpc\/.*$/, "/rpc") as `/${string}` });
    if (!matched) return new Response(null, { status: 404 });
    if (new URL(request.url).pathname.endsWith("/proposals/approve")) {
      if (script.approve === "plain-400") return Response.json({ error: "Reply lost after approval was recorded" }, { status: 400 });
      if (script.approve === "lose") return new Response(null, { status: 502 });
    }
    // A lost answer: the platform acted, the reply never arrived.
    if ((script.create === "lose-first" && creates === 1 && calls.at(-1)?.path === "create" && calls.filter(c => c.path === "create").length === 1)
      || (script.execute === "lose" && calls.at(-1)?.path === "execute")) return new Response(null, { status: 502 });
    return response;
  };
  return { calls, fetch };
}

const fresh = () => mkdtempSync(join(tmpdir(), "treasury-app-"));
const request = { requestId: "req-1", legs: [{ from: USDC, to: WNEAR, amount: "1000000" }], expiresAt: "2026-11-05T00:00:00.000Z" };
const appWith = (fixture: ReturnType<typeof platform>, state = fresh()) =>
  treasuryApp({ platform: "https://platform.example", credential: "tap_fixture", state, fetch: fixture.fetch as typeof globalThis.fetch });

test("a proposal is recorded before the call, and a lost answer resends the identical request once", async () => {
  const state = fresh(), fixture = platform({ create: "lose-first", state });
  const made = await appWith(fixture, state).propose("org_1", "portfolio", request);
  assert.equal(made.ok && made.value.state, "proposed");
  const creates = fixture.calls.filter(c => c.path === "create");
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[1]!.input, creates[0]!.input, "the same body, so the platform answers the stored proposal");
  assert.ok(existsSync(join(state, "requests", requestFile("org_1", "portfolio", "req-1"))));
});

test("the resend after a lost answer is the saved request byte for byte, expiresAt as written", async () => {
  // The platform compares JSON.stringify({ legs, expiresAt, note ?? null }) (dao/sdk@1a7fe98 src/proposals/service.ts:99):
  // a rebuilt timestamp ("…00.000Z" for "…00Z") would answer request_conflict instead of the stored proposal.
  const state = fresh(), fixture = platform({ create: "lose-first", state });
  const written = { ...request, expiresAt: "2026-11-05T00:00:00Z", note: "rebalance toward targets" };
  assert.ok((await appWith(fixture, state).propose("org_1", "portfolio", written)).ok);
  const saved = JSON.parse(readFileSync(join(state, "requests", requestFile("org_1", "portfolio", "req-1")), "utf8")).request;
  const [first, resent] = fixture.calls.filter(c => c.path === "create").map(c => c.input as typeof written);
  assert.equal(saved.expiresAt, "2026-11-05T00:00:00Z");
  for (const sent of [first!, resent!]) {
    assert.equal(JSON.stringify({ legs: sent.legs, expiresAt: sent.expiresAt, note: sent.note ?? null }),
      JSON.stringify({ legs: saved.legs, expiresAt: saved.expiresAt, note: saved.note ?? null }));
    assert.deepEqual(sent, saved);
  }
});

test("a requestId reused for other terms is refused here, with nothing sent", async () => {
  const state = fresh(), fixture = platform();
  const app = appWith(fixture, state);
  assert.ok((await app.propose("org_1", "portfolio", request)).ok);
  const other = await app.propose("org_1", "portfolio", { ...request, legs: [{ from: USDC, to: WNEAR, amount: "2000000" }] });
  assert.deepEqual(!other.ok && "code" in other && other.code, "request_conflict");
  assert.equal(fixture.calls.filter(c => c.path === "create").length, 1);
  assert.equal(commandExit(other), EXIT.notSent);
});

test("only the platform's exact text is relayed for approval or rejection", async () => {
  const fixture = platform({ read: view("proposed") }), app = appWith(fixture);
  const signed = (message: string) => ({ message, nonce: Buffer.alloc(32).toString("base64"), publicKey: "ed25519:11111111111111111111111111111111", signature: "ed25519:fixture-signature" });
  const altered = await app.decide("org_1", "portfolio", ID, "approve", signed(proposalText({ ...view("proposed"), legs: [{ ...view("proposed").legs[0]!, amount: "100000000" }] }, "approve")));
  assert.deepEqual(!altered.ok && "code" in altered && altered.code, "signature_text_mismatch");
  const flipped = await app.decide("org_1", "portfolio", ID, "approve", signed(proposalText(view("proposed"), "reject")));
  assert.deepEqual(!flipped.ok && "code" in flipped && flipped.code, "signature_text_mismatch");
  assert.equal(fixture.calls.filter(c => c.path === "approve" || c.path === "reject").length, 0);
  const approved = await app.decide("org_1", "portfolio", ID, "approve", signed(proposalText(view("proposed"), "approve")));
  assert.equal(approved.ok && approved.value.state, "approved");
  assert.deepEqual(fixture.calls.filter(c => c.path === "approve").map(c => (c.input as { id: string }).id), [ID]);
});

test("a lost execution answer is read back and never retried", async () => {
  const fixture = platform({ execute: "lose", read: view("unknown", [{ method: "swap", status: null, correlationId: null, refused: null }]) });
  const ran = await appWith(fixture).execute("org_1", "portfolio", ID);
  assert.equal(fixture.calls.filter(c => c.path === "execute").length, 1);
  assert.deepEqual(fixture.calls.map(c => c.path), ["execute", "get"]);
  assert.equal(executionExit(ran), EXIT.unknown);
});

test("execution exit codes follow the outcome's kind and state, never its message", async () => {
  const swap = (refused: string | null, status: string | null) => ({ method: "swap", status, correlationId: refused ? null : "c0ffee00-0000-4000-8000-000000000001", refused });
  const cases: [Parameters<typeof platform>[0], number][] = [
    [{ execute: view("executed", [swap(null, "SUCCESS")]) }, EXIT.ok],
    [{ execute: view("stopped", [swap(null, "SUCCESS"), swap("below_floor", null)]) }, EXIT.partial],
    [{ execute: view("stopped", [swap("below_floor", null)]) }, EXIT.notSent],
    [{ execute: view("stopped") }, EXIT.notSent],
    [{ execute: view("executing") }, EXIT.unknown],
    [{ execute: view("invalidated") }, EXIT.notSent],
    [{ execute: "not_executable" }, EXIT.notSent],
  ];
  for (const [script, exit] of cases) assert.equal(executionExit(await appWith(platform(script)).execute("org_1", "portfolio", ID)), exit, JSON.stringify(script));
});

test("a lost execution answer that still reads approved stays unknown: the platform may be about to claim it", async () => {
  // The platform re-quotes before it claims (dao/sdk@1a7fe98 src/proposals/service.ts:214, claim at :233).
  const ran = await appWith(platform({ execute: "lose", read: view("approved") })).execute("org_1", "portfolio", ID);
  assert.equal(executionExit(ran), EXIT.unknown);
});

test("the same requestId in another Organization or agent is another request", async () => {
  const fixture = platform(), app = appWith(fixture);
  for (const [organization, agent] of [["org_1", "portfolio"], ["org_2", "portfolio"], ["org_1", "other-agent"]] as const)
    assert.ok((await app.propose(organization, agent, { ...request, legs: [{ from: USDC, to: WNEAR, amount: organization === "org_2" ? "2000000" : "1000000" }] })).ok, `${organization}/${agent}`);
  assert.equal(fixture.calls.filter(c => c.path === "create").length, 3);
});

test("a proposal the platform plainly refused can be corrected under the same requestId; records are bounded", async () => {
  const fixture = platform({ create: "refuse-first" }), state = fresh(), app = appWith(fixture, state);
  const refused = await app.propose("org_1", "portfolio", request);
  assert.deepEqual(!refused.ok && "code" in refused && refused.code, "not_proposable");
  assert.equal(readdirSync(join(state, "requests")).length, 0, "nothing was stored on the platform, so nothing is kept here");
  const corrected = await app.propose("org_1", "portfolio", { ...request, legs: [{ from: USDC, to: WNEAR, amount: "500000" }] });
  assert.ok(corrected.ok);
  const bounded = treasuryApp({ platform: "https://platform.example", credential: "tap_fixture", state, fetch: fixture.fetch as typeof globalThis.fetch, maxRequests: 1 });
  const full = await bounded.propose("org_1", "portfolio", { ...request, requestId: "req-2" });
  assert.deepEqual(!full.ok && "code" in full && full.code, "too_many_requests");
  assert.equal(fixture.calls.filter(c => c.path === "create").length, 2, "a refused record sends nothing");
});

test("a plain HTTP400 after an approval was recorded remains unknown and held", async () => {
  const fixture = platform({ read: view("proposed"), approve: "plain-400" }), state = fresh(), app = appWith(fixture, state);
  const signed = { message: proposalText(view("proposed"), "approve"), nonce: Buffer.alloc(32).toString("base64"), publicKey: "ed25519:11111111111111111111111111111111", signature: "ed25519:fixture-signature" };
  const decided = await app.decide("org_1", "portfolio", ID, "approve", signed);
  assert.equal(commandExit(decided), EXIT.unknown);
  assert.equal(app.decisionHeld("proposal", "org_1", "portfolio", ID), true);
  await appWith(fixture, state).decide("org_1", "portfolio", ID, "reject", { ...signed, message: proposalText(view("proposed"), "reject") });
  assert.equal(fixture.calls.filter(call => call.path === "approve" || call.path === "reject").length, 1);
});

test("a temporary file left by a crash never blocks a later durable write", () => {
  const directory = fresh(), target = join(directory, "record.json");
  writeFileSync(`${target}.${process.pid}.tmp`, "left by a crash");
  writeDurable(target, "new");
  assert.equal(readFileSync(target, "utf8"), "new");
});

test("a platform call that never answers times out: an execution reads unknown, a read nothing sent", { timeout: 10_000 }, async () => {
  const hung = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, fail) => {
    init?.signal?.addEventListener("abort", () => fail(init.signal!.reason), { once: true });
  })) as typeof globalThis.fetch;
  const app = treasuryApp({ platform: "https://platform.example", credential: "tap_fixture", state: fresh(), fetch: hung, timeoutMs: 50 });
  const started = Date.now();
  assert.equal(executionExit(await app.execute("org_1", "portfolio", ID)), EXIT.unknown);
  assert.equal(commandExit(await app.get("org_1", "portfolio", ID)), EXIT.notSent);
  assert.ok(Date.now() - started < 5_000);
});


const proposalSignature = (nonce = 1) => ({ message: proposalText(view("proposed"), "approve"), nonce: Buffer.alloc(32, nonce).toString("base64"),
  publicKey: "ed25519:11111111111111111111111111111111", signature: "ed25519:fixture-signature" });
const activeDecision = (state: string, origin = "https://platform.example") => join(state, "decision-attempts",
  createHash("sha256").update(JSON.stringify([origin, "proposal", "org_1", "portfolio", ID])).digest("hex") + ".active");
function restartedDecision(state: string, signed = proposalSignature()) {
  const mutations = join(state, "child-mutations.txt");
  const code = `const {treasuryApp}=await import(${JSON.stringify(new URL("../app/treasury-app.ts", import.meta.url).href)});
const fs=await import('node:fs');const input=JSON.parse(process.argv[1]);
const app=treasuryApp({platform:'https://platform.example/',credential:'tap_rotated_fixture',state:input.state,fetch:async(url)=>{
const path=new URL(url).pathname;
if(path.endsWith('/proposals/get'))return Response.json({json:input.view});
fs.appendFileSync(input.mutations,path+'\\n');return Response.json({json:{...input.view,state:'approved'}});
}});
const answer=await app.decide('org_1','portfolio',input.view.id,'approve',input.signed);
console.log(JSON.stringify({answer,held:app.decisionHeld('proposal','org_1','portfolio',input.view.id)}));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code,
    JSON.stringify({ state, signed, view: view("proposed"), mutations })], { cwd: new URL("../", import.meta.url), env: process.env, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
  assert.equal(existsSync(mutations) ? readFileSync(mutations, "utf8") : "", "", "a fresh OS process never re-relays an attempted signed decision");
  return JSON.parse(result.stdout) as { answer: { ok: boolean; kind?: string; code?: string }; held: boolean };
}

test("the decision attempt is durable before relay and a fresh OS process stays poll-only while it is in flight", async () => {
  const state = fresh(); let release!: () => void;
  const gate = new Promise<void>(done => { release = done; }), fixture = platform({ read: view("proposed"), decisionGate: gate });
  const app = appWith(fixture, state), pending = app.decide("org_1", "portfolio", ID, "approve", proposalSignature());
  try {
    for (let i = 0; i < 200 && !fixture.calls.some(call => call.path === "approve"); i++) await new Promise<void>(done => setTimeout(done, 5));
    assert.ok(fixture.calls.some(call => call.path === "approve"));
    const saved = JSON.parse(readFileSync(join(activeDecision(state), "attempt.json"), "utf8"));
    assert.equal(saved.platform, "https://platform.example"); assert.equal(saved.domain, "proposal"); assert.equal(saved.verdict, "approve");
    assert.equal(saved.signedBodySha256, createHash("sha256").update(JSON.stringify(proposalSignature())).digest("hex"));
    assert.equal(readFileSync(join(activeDecision(state), "attempt.json"), "utf8").includes("fixture-signature"), false);
    assert.equal((await app.get("org_1", "portfolio", ID)).ok, true);
    const child = restartedDecision(state);
    assert.equal(child.answer.kind, "unknown"); assert.equal(child.held, true);
    await appWith(fixture, state).decide("org_1", "portfolio", ID, "reject", { ...proposalSignature(), message: proposalText(view("proposed"), "reject") });
    assert.equal(fixture.calls.filter(call => call.path === "approve" || call.path === "reject").length, 1);
  } finally { release(); }
  assert.ok((await pending).ok);
  assert.equal(restartedDecision(state).answer.kind, "unknown", "success does not make a stale proposed read safe to sign");
});

test("a torn decision claim survives a real process restart and is never inferred unsent", () => {
  const state = fresh(), app = appWith(platform(), state), active = activeDecision(state);
  mkdirSync(active, { mode: 0o700 }); writeFileSync(join(active, "attempt.json"), "{");
  assert.equal(app.decisionHeld("proposal", "org_1", "portfolio", ID), true);
  const child = restartedDecision(state); assert.equal(child.answer.kind, "unknown"); assert.equal(child.held, true);
  assert.equal(readFileSync(join(active, "attempt.json"), "utf8"), "{");
});

test("a proven refusal preserves its signed-body identity across process restart; only a fresh signature may retry", async () => {
  const state = fresh(), script = { read: view("proposed"), approve: "refuse" as "refuse" | "lose" }, fixture = platform(script), app = appWith(fixture, state);
  const refused = await app.decide("org_1", "portfolio", ID, "approve", proposalSignature());
  assert.equal(!refused.ok && refused.kind, "refused"); assert.equal(app.decisionHeld("proposal", "org_1", "portfolio", ID), false);
  const child = restartedDecision(state); assert.equal(child.answer.code, "decision_already_attempted"); assert.equal(child.held, false);
  script.approve = "lose";
  const retried = await app.decide("org_1", "portfolio", ID, "approve", proposalSignature(2));
  assert.equal(!retried.ok && retried.kind, "unknown"); assert.equal(app.decisionHeld("proposal", "org_1", "portfolio", ID), true);
  assert.equal(fixture.calls.filter(call => call.path === "approve").length, 2);
  assert.ok(readdirSync(join(state, "decision-attempts")).some(name => name.includes(".refused.")));
});

test("decision claims bind their platform origin and subject without being erased by credential rotation", async () => {
  const state = fresh(), fixture = platform({ read: view("proposed") }), app = appWith(fixture, state);
  assert.ok((await app.decide("org_1", "portfolio", ID, "approve", proposalSignature())).ok);
  assert.equal(app.decisionHeld("proposal", "org_1", "portfolio", ID), true);
  assert.equal(app.decisionHeld("proposal", "org_2", "portfolio", ID), false);
  assert.equal(app.decisionHeld("proposal", "org_1", "another", ID), false);
  assert.equal(app.decisionHeld("proposal", "org_1", "portfolio", "b".repeat(32)), false);
  assert.equal(app.decisionHeld("order", "org_1", "portfolio", ID), false);
  const other = treasuryApp({ platform: "https://other.example", credential: "tap_fixture", state, fetch: fixture.fetch as typeof globalThis.fetch });
  assert.equal(other.decisionHeld("proposal", "org_1", "portfolio", ID), false);
  assert.equal(restartedDecision(state).held, true, "origin spelling and credential rotation keep the same durable hold");
});


test("a failed preliminary decision read remains an unknown durable attempt for direct callers", async () => {
  const state = fresh(), reached: string[] = [];
  const app = treasuryApp({ platform: "https://platform.example", credential: "tap_fixture", state,
    fetch: async input => { reached.push(new URL(String(input)).pathname); return new Response(null, { status: 503 }); } });
  const answer = await app.decide("org_1", "portfolio", ID, "approve", proposalSignature());
  assert.equal(!answer.ok && answer.kind, "unknown"); assert.equal(commandExit(answer), EXIT.unknown);
  assert.equal(app.decisionHeld("proposal", "org_1", "portfolio", ID), true);
  assert.ok(reached.every(path => path.endsWith("/proposals/get")));
  assert.equal(restartedDecision(state).answer.kind, "unknown");
});
