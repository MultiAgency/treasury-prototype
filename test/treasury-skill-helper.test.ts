import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The packaged skill helper, answered in-process by an offline oRPC fixture: no network, credential or funds.
const helper = fileURLToPath(new URL("../skills/treasury/scripts/treasury.mjs", import.meta.url));
const stub = fileURLToPath(new URL("./fixtures/treasury-helper-stub.mjs", import.meta.url));
const PLAN = "6f1c2a4e-0b7d-4c3a-9e2f-1d5b8a7c6e40";

function execute(events: unknown[]) {
  const calls = join(mkdtempSync(join(tmpdir(), "treasury-helper-")), "calls");
  const result = spawnSync(process.execPath, ["--import", stub, helper, "execute", PLAN], { encoding: "utf8", env: { ...process.env,
    TREASURY_URL: "https://treasury.example", TREASURY_NAME: "portfolio",
    TREASURY_MACHINE_TOKEN: `tmc_00000000-0000-0000-0000-000000000000.${"A".repeat(43)}`,
    HELPER_STUB_EVENTS: JSON.stringify(events), HELPER_STUB_CALLS: calls } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, calls: readFileSync(calls, "utf8").trim().split("\n") };
}

// The platform's refusal (dao/sdk src/planning/strategy-grant.ts at 1a7fe98, SDK 0.4.0) when a machine credential
// executes under a grant that doesn't bind the saved strategy.
const unbound = { type: "rejected", problems: ["the agent's live grant doesn't bind the saved strategy: the owner signs a grant for it before an app or a machine credential executes plans"] };

test("a grant refusal tells the owner to authorize the saved strategy, not to retry", () => {
  const run = execute([unbound]);
  assert.equal(run.code, 1);
  assert.deepEqual(run.stdout.trim().split("\n").map(line => JSON.parse(line)), [unbound]);
  assert.match(run.stderr, /Refused before sending/);
  assert.match(run.stderr, /owner authorizes the saved strategy/);
  assert.match(run.stderr, /do not retry execute or prepare a replacement plan/);
  assert.doesNotMatch(run.stderr, /may be unknown/);
  assert.deepEqual(run.calls, ["/machine/v1/a/portfolio/rpc/executePlan"], "one executePlan, nothing resent");
});

test("other refusals keep their own reasons, without the grant guidance", () => {
  const run = execute([{ type: "rejected", problems: ["the plan was already executed"] }]);
  assert.equal(run.code, 1);
  assert.equal(run.stderr, "");
  assert.deepEqual(run.calls, ["/machine/v1/a/portfolio/rpc/executePlan"]);
});

test("a successful execution prints its events with no guidance", () => {
  const action = { type: "action", index: 0, status: "SUCCESS", correlationId: "c0ffee00-0000-4000-8000-000000000001" };
  const run = execute([action]);
  assert.equal(run.code, 0);
  assert.deepEqual(JSON.parse(run.stdout), action);
  assert.equal(run.stderr, "");
});
