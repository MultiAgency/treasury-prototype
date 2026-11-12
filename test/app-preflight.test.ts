import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PREFLIGHT_HELP, PREFLIGHT_TIMEOUT_MS, preflight } from "../scripts/treasury-app-preflight.mjs";

const CAPABILITY = "treasury-limit-orders-v1", CREDENTIAL = "tap_PRIVATE_PREFLIGHT_CREDENTIAL", NOW = Date.UTC(2026, 10, 11, 15);
const ENV = { PLATFORM_URL: "https://platform.example", TREASURY_APP_CREDENTIAL: CREDENTIAL };
const ARGS = ["--organization", "org_1", "--agent", "portfolio"];
const identity = () => ({ agent: "portfolio", owner: "owner.near", agentId: "provider-agent-1", created: true,
  host: "platform.example", deployment: "treasury-app", signer: "wallet" });
const consent = () => ({ id: "consent-1", deployment: "treasury-app", host: "platform.example", organization: "org_1", owner: "owner.near",
  agent: "portfolio", agentId: "provider-agent-1", scopes: ["read", "treasury", "treasury-orders"], expiresAt: NOW + 3_600_000,
  createdAt: NOW - 1_000, publicKey: "ed25519:fixture", revoked: false, revokedAt: null as number | null });
type FixtureOptions = { capabilities?: unknown; identity?: unknown; consents?: unknown; routeFailure?: "capabilities" | "identity" | "consents";
  status?: number; invalidJson?: boolean; throws?: boolean };
function fixture(options: FixtureOptions = {}) {
  const calls: { method: string; path: string; authorization: string | null; redirect?: RequestRedirect }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    calls.push({ method: req.method, path: `${url.pathname}${url.search}`, authorization: req.headers.get("authorization"), redirect: init?.redirect });
    assert.equal(req.method, "GET"); assert.equal(req.headers.get("authorization"), `Bearer ${CREDENTIAL}`);
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal instanceof AbortSignal, "Every SDK read has a bounded abort signal");
    const route = url.pathname === "/apps/v1/capabilities" ? "capabilities" : url.pathname === "/apps/v1/agents/portfolio" ? "identity"
      : url.pathname === "/apps/v1/consents" && url.search === "?organization=org_1" ? "consents" : undefined;
    assert.ok(route, "Only the three exact SDK read routes are allowed");
    if (route === options.routeFailure) {
      if (options.throws) throw new Error(`Transport failure containing ${CREDENTIAL}`);
      return options.invalidJson ? new Response(CREDENTIAL, { status: options.status ?? 200 })
        : Response.json({ error: `Upstream private error ${CREDENTIAL}`, code: CREDENTIAL, balances: [{ amount: CREDENTIAL }] }, { status: options.status ?? 503 });
    }
    return Response.json(route === "capabilities" ? options.capabilities ?? { capabilities: [CAPABILITY] }
      : route === "identity" ? options.identity ?? identity() : options.consents ?? { consents: [consent()] });
  };
  return { fetch, calls };
}
async function run(options: FixtureOptions = {}, args: string[] = []) {
  const server = fixture(options), answer = await preflight({ args, env: ENV, fetch: server.fetch, now: () => NOW });
  assert.ok("summary" in answer);
  assert.ok(!JSON.stringify(answer).includes(CREDENTIAL), "Neither errors nor successful upstream bodies may expose a credential");
  return { ...answer, calls: server.calls };
}
const paths = (calls: ReturnType<typeof fixture>["calls"]) => calls.map(call => `${call.method} ${call.path}`);

test("capability-only preflight accepts the minimal SDK body and makes one credentialed GET", async () => {
  const result = await run({ capabilities: { capabilities: [CAPABILITY], privateError: CREDENTIAL, balances: [CREDENTIAL] } });
  assert.equal(result.exit, 0); assert.equal(result.summary.ok, true); assert.equal(result.summary.readOnly, true);
  assert.deepEqual(result.summary.checks.capabilities, { status: "passed", kind: "supported" });
  assert.deepEqual(paths(result.calls), ["GET /apps/v1/capabilities"]);
  assert.deepEqual(result.summary.checks.identity, { status: "not_checked", kind: "not_requested" });
  assert.deepEqual(result.summary.checks.consent, { status: "not_checked", kind: "not_requested" });
});

test("absent and malformed capabilities fail closed with no public or agent-route fallback", async () => {
  for (const capabilities of [{ capabilities: [] }, { capabilities: ["treasury-proposals-v1"] }, { capabilities: [CAPABILITY, 1] }, {}]) {
    const result = await run({ capabilities });
    assert.equal(result.exit, 2); assert.equal(result.summary.ok, false);
    assert.deepEqual(paths(result.calls), ["GET /apps/v1/capabilities"]);
    assert.equal(result.summary.checks.capabilities.status, "blocked");
  }
});

test("capability route failures expose only SDK result kinds and never retry or use gateway discovery", async () => {
  for (const [status, kind] of [[401, "session"], [403, "forbidden"], [404, "refused"], [429, "rate_limited"], [503, "unavailable"]] as const) {
    const result = await run({ routeFailure: "capabilities", status });
    assert.equal(result.exit, 2); assert.equal(result.summary.checks.capabilities.kind, kind);
    assert.deepEqual(paths(result.calls), ["GET /apps/v1/capabilities"]);
    assert.ok(!JSON.stringify(result.summary).includes("Upstream private error"));
  }
  for (const fault of [{ invalidJson: true }, { throws: true }]) {
    const result = await run({ routeFailure: "capabilities", ...fault });
    assert.equal(result.summary.checks.capabilities.kind, "unavailable"); assert.equal(result.exit, 2);
    assert.equal(result.calls.length, 1);
  }
});

test("a tuple adds only SDK identity and consent reads and requires one matching live order consent", async () => {
  const result = await run({}, ARGS);
  assert.equal(result.exit, 0);
  assert.deepEqual(paths(result.calls), ["GET /apps/v1/capabilities", "GET /apps/v1/agents/portfolio", "GET /apps/v1/consents?organization=org_1"]);
  assert.deepEqual(result.summary.checks.identity, { status: "passed", kind: "current" });
  assert.deepEqual(result.summary.checks.consent, { status: "passed", kind: "live_order_consent" });
  assert.ok(!JSON.stringify(result.summary).includes("owner.near"), "The summary contains no raw identity or consent bodies");
});

test("revoked, expired, wrong-owner, wrong-provider, wrong-host and wrong-deployment consents grant no readiness", async () => {
  for (const changes of [
    { revoked: true }, { expiresAt: NOW }, { expiresAt: NOW - 1 }, { revokedAt: NOW - 1 },
    { organization: "another-org" }, { agent: "another-agent" }, { owner: "previous.near" }, { agentId: "replaced-provider" },
    { host: "other.example" }, { deployment: "another-app" }, { signer: "dao" },
    { scopes: ["read", "treasury"] }, { scopes: ["read", "treasury", "treasury-execute"] }, { scopes: ["treasury-orders"] },
  ]) {
    const result = await run({ consents: { consents: [{ ...consent(), ...changes }] } }, ARGS);
    assert.equal(result.exit, 2, JSON.stringify(changes));
    assert.equal(result.summary.checks.consent.kind, "missing_live_order_consent", JSON.stringify(changes));
    assert.equal(result.calls.length, 3);
  }
});

test("order scopes must coexist on one live bound consent; a later matching consent may establish readiness", async () => {
  const pieces = [{ ...consent(), scopes: ["treasury"] }, { ...consent(), scopes: ["treasury-orders"] }];
  assert.equal((await run({ consents: { consents: pieces } }, ARGS)).exit, 2);
  assert.equal((await run({ consents: { consents: [...pieces, { ...consent(), revoked: true }, consent()] } }, ARGS)).exit, 0);
});

test("DAO identity requires DAO consent and legacy omitted signer means wallet only", async () => {
  const dao = { ...identity(), owner: "owner.sputnik-dao.near", signer: "dao" };
  const matching = { ...consent(), owner: dao.owner, signer: "dao" };
  assert.equal((await run({ identity: dao, consents: { consents: [matching] } }, ARGS)).exit, 0);
  const { signer: _signer, ...withoutSigner } = matching;
  assert.equal((await run({ identity: dao, consents: { consents: [withoutSigner] } }, ARGS)).exit, 2);
  const { signer: _walletSigner, ...oldIdentity } = identity();
  assert.equal((await run({ identity: oldIdentity }, ARGS)).exit, 0);
});

test("missing or changed identity never falls through to a successful consent check", async () => {
  for (const changes of [{ created: false }, { agentId: null }, { agentId: "" }, { agent: "other" }, { owner: "" }, { host: "" }, { deployment: "" }]) {
    const result = await run({ identity: { ...identity(), ...changes } }, ARGS);
    assert.equal(result.exit, 2); assert.equal(result.summary.checks.identity.status, "blocked");
    assert.equal(result.summary.checks.consent.kind, "identity_unverified");
  }
});

test("tuple route outages and malformed identity or consent bodies return sanitized failure kinds", async () => {
  for (const routeFailure of ["identity", "consents"] as const) {
    const result = await run({ routeFailure, status: 503 }, ARGS);
    assert.equal(result.exit, 2);
    assert.equal(result.summary.checks[routeFailure === "identity" ? "identity" : "consent"].kind, "unavailable");
    assert.equal(result.calls.length, 3);
  }
  assert.equal((await run({ identity: { agent: "portfolio" } }, ARGS)).exit, 2);
  assert.equal((await run({ consents: { consents: [{ ...consent(), expiresAt: "later" }] } }, ARGS)).exit, 2);
});

test("invalid configuration and incomplete arguments return stable codes without any request or secret value", async () => {
  let calls = 0;
  const noFetch: typeof globalThis.fetch = async () => { calls++; throw new Error(CREDENTIAL); };
  for (const value of [undefined, "", "http://platform.example", "https://user:private@platform.example", "https://platform.example/path",
    "https://platform.example?private", "https://platform.example#private", "https://platform.example?", " https://platform.example ",
    "https://@platform.example", "https:platform.example", "https://platform.example/path/..", "https://plat\tform.example", "invalid"]) {
    const result = await preflight({ env: { ...ENV, PLATFORM_URL: value }, fetch: noFetch });
    assert.equal(result.exit, 2); assert.ok("summary" in result); assert.equal(result.summary.checks.configuration.kind, "platform_url_invalid");
    assert.ok(!JSON.stringify(result).includes(CREDENTIAL));
  }
  for (const args of [["--organization", "org_1"], ["--agent", "portfolio"], ["--unknown", CREDENTIAL], ["--agent"],
    [...ARGS, "--agent", "second"], ["--organization", "org with spaces", "--agent", "portfolio"]]) {
    const result = await preflight({ args, env: ENV, fetch: noFetch });
    assert.equal(result.exit, 2); assert.ok(!JSON.stringify(result).includes(CREDENTIAL));
  }
  for (const TREASURY_APP_CREDENTIAL of [undefined, "", "   ", "tap_\nprivate"]) {
    const result = await preflight({ env: { ...ENV, TREASURY_APP_CREDENTIAL }, fetch: noFetch });
    assert.equal(result.exit, 2);
  }
  assert.equal(calls, 0);
});

test("--help returns before configuration or SDK calls and import has no preflight side effects", async () => {
  let calls = 0;
  const answer = await preflight({ args: ["--help"], env: {}, fetch: async () => { calls++; throw new Error("Must not call"); } });
  assert.equal(answer.exit, 0); assert.ok("help" in answer); assert.equal(answer.help, PREFLIGHT_HELP); assert.equal(calls, 0);
  assert.equal(PREFLIGHT_TIMEOUT_MS, 15_000);
});

test("a stalled SDK read is bounded and returns unavailable without replay", { timeout: 2_000 }, async () => {
  const calls: string[] = [];
  const stalled: typeof globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    return new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error(CREDENTIAL)), { once: true }));
  };
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const result = await preflight({ env: ENV, fetch: stalled, timeoutMs: 20 });
    assert.equal(result.exit, 2); assert.ok("summary" in result); assert.equal(result.summary.checks.capabilities.kind, "unavailable");
    assert.deepEqual(calls, ["https://platform.example/apps/v1/capabilities"]);
    assert.ok(!JSON.stringify(result).includes(CREDENTIAL));
  } finally { clearTimeout(keepAlive); }
});

test("the actual CLI prints sanitized JSON, respects --help without env, and writes no app state", () => {
  const scratch = mkdtempSync(join(tmpdir(), "app-preflight-cli-"));
  const script = fileURLToPath(new URL("../scripts/treasury-app-preflight.mjs", import.meta.url));
  const preload = join(scratch, "sdk-fixture.mjs");
  const privateEnv = { ...process.env, ...ENV };
  try {
    writeFileSync(preload, `globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== "https://platform.example/apps/v1/capabilities" || request.method !== "GET" || request.headers.get("authorization") !== "Bearer ${CREDENTIAL}") throw new Error("${CREDENTIAL}");
      return Response.json({ capabilities: ["${CAPABILITY}"], privateValue: "${CREDENTIAL}", balances: ["${CREDENTIAL}"] });
    };\n`);
    const before = readdirSync(scratch).sort();
    const success = spawnSync(process.execPath, ["--import", preload, script], { cwd: scratch, env: privateEnv, encoding: "utf8", timeout: 5_000 });
    assert.equal(success.status, 0, success.stderr); assert.equal(JSON.parse(success.stdout).ok, true);
    assert.ok(!`${success.stdout}${success.stderr}`.includes(CREDENTIAL));
    const config = spawnSync(process.execPath, [script], { cwd: scratch, env: { ...privateEnv, PLATFORM_URL: `https://user:${CREDENTIAL}@platform.example` }, encoding: "utf8", timeout: 5_000 });
    assert.equal(config.status, 2); assert.equal(JSON.parse(config.stdout).checks.configuration.kind, "platform_url_invalid");
    assert.ok(!`${config.stdout}${config.stderr}`.includes(CREDENTIAL));
    const help = spawnSync(process.execPath, [script, "--help"], { cwd: scratch,
      env: { ...privateEnv, PLATFORM_URL: "", TREASURY_APP_CREDENTIAL: "" }, encoding: "utf8", timeout: 5_000 });
    assert.equal(help.status, 0); assert.match(help.stdout, /^Usage:/); assert.equal(help.stderr, "");
    assert.deepEqual(readdirSync(scratch).sort(), before, "No state or evidence files are created by the CLI");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
