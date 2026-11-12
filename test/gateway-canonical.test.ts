import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TSX } from "./fixtures/harness.js";
import { generateKey, Near, type PrivateKey } from "near-kit";

test("the legacy host redirects pages but never forwards API calls or replays bodies", async () => {
  const probe = createServer().listen(0, "127.0.0.1");
  await new Promise<void>(resolve => probe.once("listening", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const dir = mkdtempSync(join(tmpdir(), "canonical-gateway-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ host: "treasury.test", redirect_hosts: ["proto.test"], signin_hosts: ["fallback.test"],
    agents: [{ name: "treasury", owner: "owner.test", area: "treasury", port: 65530 }] }));
  const child = spawn(TSX, [join(process.cwd(), "src/gateway/server.ts")], {
    cwd: dir, env: { ...process.env, PORT: String(port), DASHBOARD_FILE: file,
      DASHBOARD_HOST: "treasury.test", TREASURY_SELF_SERVICE: "false", SESSION_SECRET: "offline-canonical-host-test-secret-32-characters" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", bytes => { errors += bytes; });
  const call = (path: string, method = "GET", host = "proto.test", extra: Record<string, string> = {}, body?: string) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, method, headers: { host, ...extra } }, res => {
        let body = ""; res.on("data", bytes => { body += bytes; });
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject); req.end(body ?? (method === "POST" ? '{"json":{"planId":"must-not-replay"}}' : undefined));
    });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${errors}`)), 10_000);
      child.stdout.on("data", bytes => { if (String(bytes).includes("Dashboard for")) { clearTimeout(timer); resolve(); } });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}: ${errors}`)); });
    });
    for (const method of ["GET", "HEAD"]) {
      const answer = await call("/a/treasury/follow/run?run=retained", method);
      assert.equal(answer.status, 302);
      assert.equal(answer.headers.location, "https://treasury.test/a/treasury/follow/run?run=retained");
      assert.equal(answer.headers["cache-control"], "no-store");
      assert.equal(answer.headers["set-cookie"], undefined);
      assert.equal(answer.headers["x-frame-options"], "DENY");
    }
    for (const path of ["/gw/challenge", "/gw/me", "/a/treasury/rpc/overview", "/rpc/overview"])
      assert.equal((await call(path)).status, 421, path);
    for (const path of ["/gw/session", "/gw/logout", "/a/treasury/rpc/executePlan", "/"])
      for (const method of ["POST", "PUT", "DELETE", "OPTIONS"])
        assert.equal((await call(path, method)).status, 421, `${method} ${path}`);
    assert.equal((await call("/health")).status, 200);
    const canonical = await call("/gw/challenge", "GET", "treasury.test");
    assert.equal(canonical.status, 200);
    assert.match(canonical.body, /treasury\.test/);
    assert.equal((await call("/a/treasury/rpc/executePlan", "POST", "treasury.test")).status, 401);
    const hostile = await call("//evil.test/path?next=https://evil.test", "GET", "proto.test", { "x-forwarded-host": "evil.test" });
    assert.equal(new URL(String(hostile.headers.location)).origin, "https://treasury.test");
    const fallback = await call("/gw/challenge", "GET", "fallback.test");
    assert.equal(fallback.status, 200);
    assert.equal(JSON.parse(fallback.body).recipient, "fallback.test");
    const challenge = JSON.parse(fallback.body);
    const key = generateKey();
    const near = new Near({ network: "mainnet", privateKey: key.secretKey as PrivateKey, defaultSignerId: "owner.test" });
    const signed = await near.signMessage({ ...challenge, nonce: Buffer.from(challenge.nonce, "base64"), callbackUrl: "https://fallback.test/" });
    const verified = await call("/gw/session", "POST", "fallback.test", { origin: "https://fallback.test", "content-type": "application/json" },
      JSON.stringify({ ...signed, nonce: challenge.nonce, callbackUrls: ["https://fallback.test/"] }));
    assert.equal(verified.status, 401);
    assert.match(JSON.parse(verified.body).error, /is not a key of owner\.test/,
      "the fallback signature and callback verify before the offline chain lookup refuses the synthetic key");
    assert.equal(verified.headers["set-cookie"], undefined);
    assert.equal((await call("/gw/challenge", "GET", "unlisted.test", { "x-forwarded-host": "fallback.test" })).status, 421,
      "forwarded host cannot select a signing host");
    assert.equal((await call("/gw/session", "POST", "unlisted.test")).status, 421);
    assert.equal((await call("/gw/session", "POST", "fallback.test", { origin: "https://treasury.test" })).status, 403);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    await new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once("exit", () => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
