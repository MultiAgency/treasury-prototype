import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT } from "../app/treasury-app.js";
import { AGENT, appPlatform, HOST, ID, ORG, OWNER, USDC, WNEAR } from "./fixtures/app-platform.js";

// The packaged Treasury app helper as a child process, against the real app server and the fixture platform
// (test/fixtures/app-platform.ts); its HTTPS requests go to loopback through test/fixtures/app-helper-stub.mjs.
const { world, reached, calls, tokens, port } = appPlatform("app-helper");
const helper = fileURLToPath(new URL("../skills/treasury/scripts/treasury-app.mjs", import.meta.url));
const stub = fileURLToPath(new URL("./fixtures/app-helper-stub.mjs", import.meta.url));
const issue = (scopes: ("read" | "propose")[]) =>
  tokens.issue({ organization: ORG, agent: AGENT, label: "assistant", scopes }, { owner: OWNER, agentId: "agent-1", host: HOST }).secret;

function helperRun(args: string[], { token = issue(["read", "propose"]), lose = "", url = `https://${HOST}` } = {}) {
  // Each run logs what reached the app server through the stub.
  const requestLog = join(mkdtempSync(join(tmpdir(), "helper-requests-")), "requests");
  return new Promise<{ code: number | null; stdout: string; stderr: string; token: string; requests: string }>((done, failed) => {
    const child = spawn(process.execPath, ["--import", stub, helper, ...args], { env: { ...process.env,
      TREASURY_APP_URL: url, TREASURY_ORGANIZATION: ORG, TREASURY_AGENT: AGENT, TREASURY_APP_TOKEN: token,
      HELPER_APP_PORT: String(port()), HELPER_LOSE: lose, HELPER_REQUESTS: requestLog } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", failed);
    child.once("close", code => done({ code, stdout, stderr, token, requests: existsSync(requestLog) ? readFileSync(requestLog, "utf8") : "" }));
  });
}
const terms = (body: object) => { const file = join(mkdtempSync(join(tmpdir(), "terms-")), "terms.json"); writeFileSync(file, JSON.stringify(body)); return file; };
const swaps = { legs: [{ from: USDC, to: WNEAR, amount: "1000000" }], expiresAt: "2026-11-05T00:00:00Z" };

test("reads answer 0 with the platform's result as JSON, and never print the token", async () => {
  for (const [args, check] of [[["unresolved"], (v: any) => assert.deepEqual(v.value, [])], [["proposals"], (v: any) => assert.equal(v.value.proposals.length, 1)],
    [["proposal", ID], (v: any) => assert.equal(v.value.state, "proposed")]] as const) {
    const run = await helperRun([...args]);
    assert.equal(run.code, EXIT.ok, `${args}: ${run.stderr}`);
    check(JSON.parse(run.stdout));
    assert.ok(!run.stdout.includes(run.token) && !run.stderr.includes(run.token));
  }
});

test("propose sends the file's terms once under the given request ID, expiresAt as written", async () => {
  const run = await helperRun(["propose", terms(swaps), "--request-id", "req-7"]);
  assert.equal(run.code, EXIT.ok, run.stderr);
  assert.equal(JSON.parse(run.stdout).value.state, "proposed");
  const created = calls.filter(c => c.path === "proposals/create");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]!.input, { requestId: "req-7", ...swaps });
});

test("a usage or configuration mistake exits 2 and sends nothing", async () => {
  // Each refused by the helper itself, before any request: the message says which rule.
  for (const [args, options, why] of [[["propose", terms(swaps)], {}, /--request-id ID/], [["propose", terms({ ...swaps, requestId: "x" }), "--request-id", "y"], {}, /request ID goes on the command line/],
    [["execute", ID], {}, /^Usage/], [["proposal", "not-an-id"], {}, /proposal's ID/], [["unresolved"], { url: `http://${HOST}` }, /HTTPS origin/],
    [["unresolved"], { token: "tmc_wrong" }, /TREASURY_APP_TOKEN/]] as const) {
    const run = await helperRun([...args], options);
    assert.equal(run.code, EXIT.notSent, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, why, args.join(" "));
    assert.equal(run.requests, "", `${args.join(" ")}: no request reached the app`);
  }
  assert.deepEqual(reached, []);
});

test("a refusal exits 2 with the reason; a lost write exits 3 and says to read, a lost read exits 2", async () => {
  const refused = await helperRun(["propose", terms(swaps), "--request-id", "req-8"], { token: issue(["read"]) });
  assert.equal(refused.code, EXIT.notSent);
  assert.match(refused.stderr, /Nothing was sent: This token lacks the propose scope/);
  for (const lose of ["after-send", "malformed"]) {
    const before = calls.filter(c => c.path === "proposals/create").length;
    const write = await helperRun(["propose", terms(swaps), "--request-id", `req-${lose}`], { lose });
    assert.equal(write.code, EXIT.unknown, lose);
    assert.match(write.stderr, /may have taken effect.*never propose again under a new request ID/);
    assert.equal(calls.filter(c => c.path === "proposals/create").length - before, 1, `${lose}: one request, never resent by the helper`);
    for (const run of [write, refused]) assert.ok(!run.stdout.includes(run.token) && !run.stderr.includes(run.token), "no token in any output");
    const read = await helperRun(["unresolved"], { lose });
    assert.equal(read.code, EXIT.notSent, lose);
    assert.match(read.stderr, /Reading again is safe/);
  }
});

test("no outcome ever exits 1", async () => {
  for (const args of [[], ["inspect", "extra"], ["withdraw", ID]]) assert.notEqual((await helperRun(args)).code, 1, args.join(" "));
});

test("a platform refusal exits 2 and names the platform's reason and code", async () => {
  world.refuseCreate = "not_proposable";
  const run = await helperRun(["propose", terms(swaps), "--request-id", "req-9"]);
  assert.equal(run.code, EXIT.notSent);
  assert.match(run.stderr, /^Nothing was sent: a leg's floor is above the quote \(not_proposable\)$/m);
});
