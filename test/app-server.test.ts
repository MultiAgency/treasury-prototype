import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { generateKey, Near, type PrivateKey } from "near-kit";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeTokens } from "../app/runtime-tokens.js";
import { createAppServer } from "../app/server.js";
import { treasuryApp } from "../app/treasury-app.js";
import { type KeyLookup, sessionToken } from "../shared/signin.js";

// The Treasury app's own server, on loopback, with a fixture key lookup: no chain, wallet or network.
const HOST = "treasury-app.test", SECRET = "s".repeat(32);
let permission: Awaited<ReturnType<KeyLookup>> = "FullAccess";
// Sign-in never reaches the platform: its fetch fails the test if called.
const state = mkdtempSync(join(tmpdir(), "app-server-"));
const offline = treasuryApp({ platform: "https://platform.example", credential: "tap_fixture", state,
  fetch: (async () => { throw new Error("sign-in must not call the platform"); }) as typeof globalThis.fetch });
// A built web/ with both entries: the app serves only the proposals page and its assets.
const web = join(state, "web");
mkdirSync(join(web, "static/js"), { recursive: true });
writeFileSync(join(web, "proposals.html"), "<!doctype html><title>proposals entry</title>");
writeFileSync(join(web, "index.html"), "<!doctype html><title>gateway entry</title>");
writeFileSync(join(web, "static/js/proposals.js"), "console.log('proposals');");
const deps = { platform: offline, tokens: new RuntimeTokens(join(state, "tokens")), web };
const server = createAppServer({ host: HOST, secret: SECRET, keyLookup: async () => permission, secure: false, ...deps });
let port = 0;
before(() => new Promise<void>(done => server.listen(0, "127.0.0.1", () => { port = (server.address() as AddressInfo).port; done(); })));
after(() => new Promise<void>(done => server.close(() => done())));

/** Raw HTTP, so the Host header is exactly as sent. */
function call(path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; body: any; cookie?: string }>((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: HOST, ...(body !== undefined && { "content-type": "application/json" }), ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk)).on("end", () => { const text = Buffer.concat(chunks).toString(); let body: any = text;
        try { body = JSON.parse(text || "null"); } catch { /* a page or asset */ }
        done({ status: res.statusCode!, body,
        cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] }); });
    });
    req.on("error", fail); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Signs a challenge the way a wallet does (near-kit's NEP-413 signer). */
async function signed(account = "owner.near", recipient = HOST) {
  const challenge = (await call("/app/challenge")).body;
  const near = new Near({ network: "mainnet", privateKey: generateKey().secretKey as PrivateKey, defaultSignerId: account });
  const signature = await near.signMessage({ message: challenge.message, recipient, nonce: Buffer.from(challenge.nonce, "base64") });
  return { accountId: account, publicKey: signature.publicKey, signature: signature.signature, nonce: challenge.nonce };
}

test("the owner signs in with a wallet signature for this host, and signs out", async () => {
  permission = "FullAccess";
  assert.equal((await call("/app/me")).status, 401);
  const opened = await call("/app/session", { method: "POST", body: await signed() });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.account, "owner.near");
  assert.match(opened.cookie!, /^treasury_app_session=/);
  assert.deepEqual((await call("/app/me", { headers: { cookie: opened.cookie! } })).body, { account: "owner.near" });
  const closed = await call("/app/logout", { method: "POST", headers: { cookie: opened.cookie! } });
  assert.equal(closed.cookie, "treasury_app_session=");
});

test("a sign-in fails for another host's signature, a function-call key, or a used challenge", async () => {
  permission = "FullAccess";
  assert.equal((await call("/app/session", { method: "POST", body: await signed("owner.near", "elsewhere.test") })).status, 401);
  permission = "FunctionCall";
  assert.equal((await call("/app/session", { method: "POST", body: await signed() })).status, 401);
  permission = "FullAccess";
  const once = await signed();
  assert.equal((await call("/app/session", { method: "POST", body: once })).status, 200);
  assert.equal((await call("/app/session", { method: "POST", body: once })).status, 401, "a challenge signs in once");
});

test("only this app's host and pages are served; other hosts and cross-site writes are refused", async () => {
  for (const path of ["/app/challenge", "/app/me"]) assert.equal((await call(path, { headers: { host: "elsewhere.test" } })).status, 421, path);
  assert.equal((await call("/app/session", { method: "POST", headers: { origin: "https://elsewhere.test" }, body: {} })).status, 403);
  assert.equal((await call("/health", { headers: { host: "elsewhere.test" } })).status, 200, "health needs no host");
});

test("another app's session cookie never counts here, even signed with the same secret", async () => {
  const foreign = `dao_session=${sessionToken("owner.near", SECRET)}`;
  assert.equal((await call("/app/me", { headers: { cookie: foreign } })).status, 401);
});

test("the app's host serves the proposals page and its assets, never the gateway's index", async () => {
  const page = await call("/");
  assert.equal(page.status, 200);
  assert.match(page.body, /proposals entry/);
  assert.match((await call("/static/js/proposals.js")).body, /proposals/);
  for (const path of ["/index.html", "/a/treasury/", "/proposals.html/../index.html", "/static/js", "/static/anything"]) assert.doesNotMatch(String((await call(path)).body), /gateway entry/, path);
  assert.equal((await call("/", { headers: { host: "elsewhere.test" } })).status, 421);
});

test("the server refuses to start with a short session secret", () => {
  assert.throws(() => createAppServer({ host: HOST, secret: "short", keyLookup: async () => "FullAccess", ...deps }), /SESSION_SECRET/);
});
