import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { invoiceHandler } from "../src/invoice-http.js";
import { ChallengeLimit, clientAddress, issueChallenge, MAX_CHALLENGES } from "../shared/signin.js";
import { TSX } from "./fixtures/harness.js";

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const GATEWAY = fileURLToPath(new URL("../src/gateway/server.ts", import.meta.url));

/** Sends one raw HTTP request (so malformed targets reach the handler) and returns the status code. */
function raw(port: number, request: string) {
  return new Promise<number>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    let data = "";
    socket.on("data", (chunk) => { data += chunk; if (/\r\n/.test(data)) { socket.end(); resolve(Number(data.split(" ")[1])); } });
    socket.on("error", reject);
  });
}

test("a malformed request target is answered 400 and the invoice page keeps serving", async () => {
  const server: Server = createServer(invoiceHandler).listen(0, "127.0.0.1");
  after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  for (const target of ["http://[/", "http://a%00/"]) assert.equal(await raw(port, `GET ${target} HTTP/1.1\r\nHost: localhost\r\n\r\n`), 400);
  assert.equal(await raw(port, "GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n"), 200);
});

test("a malformed Origin or URL never ends the dashboard process", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  // Approve-only, so it takes no lease and starts no loops: only the HTTP guard is under test.
  const child = spawn(TSX, [SERVER], { env: { ...process.env, PORT: String(port), EXECUTOR: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  after(() => child.kill());
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (d) => { if (String(d).includes("Treasury dashboard")) resolve(); });
    child.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
  assert.equal(await raw(port, `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nOrigin: null\r\n\r\n`), 403);
  assert.equal(await raw(port, `GET http://[/ HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`), 400);
  assert.equal(child.exitCode, null, "still running");
  assert.equal(await raw(port, `GET /index.html HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`) > 0, true);
});

test("open sign-in challenges are capped, so a flood can't grow memory without bound", () => {
  const now = Date.now();
  for (let i = 0; i < MAX_CHALLENGES; i++) issueChallenge("localhost", now);
  assert.throws(() => issueChallenge("localhost", now), ChallengeLimit);
  // Expired ones free their slots.
  assert.doesNotThrow(() => issueChallenge("localhost", now + 6 * 60_000));
});

for (const secret of ["", "short"]) test(`the gateway refuses to start with SESSION_SECRET=${JSON.stringify(secret)}`, async () => {
  const child = spawn(TSX, [GATEWAY], { env: { ...process.env, DASHBOARD_FILE: "deploy/legacy-dashboard.json", SESSION_SECRET: secret, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /SESSION_SECRET/);
});

test("behind a trusted proxy, rate limits key on the address the proxy appended, not one the client sent", () => {
  const req = { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7" }, socket: { remoteAddress: "10.0.0.1" } } as never;
  process.env.TRUST_PROXY = "true";
  assert.equal(clientAddress(req), "203.0.113.7");
  delete process.env.TRUST_PROXY;
  assert.equal(clientAddress(req), "10.0.0.1");
});
