import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// Run the actual image inputs, web builder and app entrypoint in an isolated directory. This proves the source/runtime
// boundary on the current host, not the resulting Linux Docker image or any deployed platform/provider behavior.
const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "treasury-app-build-"));
const build = join(scratch, "build"), runtime = join(scratch, "runtime"), state = join(scratch, "state");
const host = "treasury-app.build.test", credential = `tap_build_fixture_${randomUUID()}`, secret = `build_session_fixture_${randomUUID()}`;
const guard = join(root, "test/fixtures/offline-network.cjs"), networkLog = join(scratch, "outbound.jsonl"), recorder = join(scratch, "record-network.cjs");
const ipcLog = join(scratch, "tsx-ipc.jsonl");
const retainedState = `retained-fixture-state-${randomUUID()}`;
const systemKeys = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "TERM", "NO_COLOR", "FORCE_COLOR"];
const systemEnv = Object.fromEntries(systemKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!])) as Record<string, string>;
const launchers = ["rsbuild", "tsx"].map(name => join(root, "node_modules/.bin", name));
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const launcherDigests = launchers.map(digest);
let port = 0, child: ChildProcess | undefined, output = "";

/** Resolve only paths inside an image's /app workdir. New COPY syntax must be reviewed before this fixture accepts it. */
function imagePath(directory: string, path: string) {
  const normalized = isAbsolute(path) ? relative("/app", path) : path;
  const resolved = resolve(directory, normalized);
  assert.ok(resolved === directory || (!relative(directory, resolved).startsWith("..") && !isAbsolute(relative(directory, resolved))), `COPY escapes /app: ${path}`);
  return resolved;
}

function copyInstruction(line: string, directory: string, fromBuild = false) {
  const words = line.slice("COPY ".length).trim().split(/\s+/);
  const from = words.find(word => word.startsWith("--from="));
  const paths = words.filter(word => !word.startsWith("--"));
  assert.ok(paths.length >= 2 && paths.every(path => !/[\[\]*?"']/.test(path)), `Review unsupported COPY syntax: ${line}`);
  assert.ok(words.filter(word => word.startsWith("--")).every(word => word === from || word.startsWith("--chown=")), `Review COPY options: ${line}`);
  const destination = paths.pop()!;
  if (fromBuild) assert.equal(from, "--from=build", "The app runtime copies only this repository's own build stage");
  else assert.equal(from, undefined, "Build inputs must come from this checkout");
  for (const source of paths) {
    const input = fromBuild ? imagePath(build, source) : imagePath(root, source);
    assert.notEqual(input, root, "The app image uses explicit source inputs, never the entire checkout");
    const target = imagePath(directory, destination === "./" || paths.length > 1 ? join(destination, basename(source)) : destination);
    mkdirSync(dirname(target), { recursive: true });
    if (source.replace(/^\/app\//, "").replace(/^\.\//, "") === "node_modules") {
      assert.ok(fromBuild, "Installed dependencies are shared read-only after the build-input capture");
      symlinkSync(join(root, "node_modules"), target, "dir");
    } else cpSync(input, target, { recursive: true, filter: file => fromBuild || !["node_modules", "dist", ".git", ".app", ".ops", ".owner-intents", ".env"].includes(basename(file)) && !basename(file).startsWith(".env.") });
  }
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}

async function availablePort() {
  const reservation = createServer();
  await new Promise<void>((done, fail) => { reservation.once("error", fail); reservation.listen(0, "127.0.0.1", done); });
  const assigned = (reservation.address() as AddressInfo).port;
  await new Promise<void>((done, fail) => reservation.close(error => error ? fail(error) : done()));
  return assigned;
}

const runtimeEnv = () => ({ ...systemEnv, NODE_ENV: "production", APP_DIR: runtime, APP_HOST: host,
  PLATFORM_URL: "https://127.0.0.1:9", TREASURY_APP_CREDENTIAL: credential, SESSION_SECRET: secret,
  APP_STATE: state, APP_WEB_DIST: join(runtime, "web/dist"), PORT: String(port),
  // A second guard records any attempted startup/private read, including one an app might catch and hide.
  NODE_OPTIONS: `--require ${JSON.stringify(guard)} --require ${JSON.stringify(recorder)}` });

function call(path: string, { method = "GET", signingHost = host }: { method?: string; signingHost?: string } = {}) {
  return new Promise<{ status: number; body: string; contentType: string }>((done, fail) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers: { host: signingHost } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk)).on("end", () => done({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), contentType: res.headers["content-type"] ?? "" }));
    });
    req.setTimeout(3_000, () => req.destroy(new Error("App fixture request timed out")));
    req.once("error", fail); req.end();
  });
}

before(async () => {
  mkdirSync(build); mkdirSync(runtime);
  const dockerfile = readFileSync(join(root, "Dockerfile.app"), "utf8");
  const instructions = dockerfile.replace(/\\\n\s*/g, " ").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  let stage = "", built = false;
  for (const instruction of instructions) {
    if (instruction.startsWith("FROM ")) { stage = /\sAS\s+(\S+)$/i.exec(instruction)?.[1] ?? "runtime"; continue; }
    if (instruction === "RUN pnpm build:web") {
      assert.equal(stage, "build"); assert.equal(built, false, "One explicit web-build boundary");
      symlinkSync(join(root, "node_modules"), join(build, "node_modules"), "dir");
      const result = spawnSync(process.execPath, [join(root, "node_modules/@rsbuild/core/bin/rsbuild.js"), "build", "--root", "web", "--no-env"],
        { cwd: build, env: { ...systemEnv, NODE_ENV: "production", PUBLIC_TREASURY_ONLY: "true", NODE_OPTIONS: `--require ${JSON.stringify(guard)}` }, encoding: "utf8", timeout: 90_000 });
      assert.equal(result.status, 0, `Declared app image inputs must build real proposals assets:\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
      built = true; continue;
    }
    if (instruction.startsWith("COPY ")) {
      if (stage === "build") { assert.equal(built, false, "Copy build inputs before the web build"); copyInstruction(instruction, build); }
      else { assert.equal(built, true, "Runtime artifacts must come after the real build"); copyInstruction(instruction, runtime, instruction.includes("--from=")); }
    }
  }
  assert.equal(built, true, "Dockerfile.app must declare its real web build");
  assert.ok(existsSync(join(runtime, "deploy/app-entrypoint.sh")), "The runtime copies its real entrypoint");
  mkdirSync(state, { mode: 0o700 }); writeFileSync(join(state, "retained-state.txt"), retainedState, { mode: 0o600 });
  writeFileSync(recorder, `const fs = require("node:fs"), net = require("node:net"), os = require("node:os"), path = require("node:path");
const deny = event => { fs.appendFileSync(${JSON.stringify(networkLog)}, JSON.stringify(event) + "\\n"); throw new Error("Unexpected outbound request in app startup fixture"); };
// Installed tsx's getPipePath(process.ppid) notifies its parent loader through exactly this local Unix socket.
// The observed startup attempts had no host or port and this path. No other IPC or TCP destination is allowed.
const tsxPipe = path.join(os.tmpdir(), "tsx-" + (process.geteuid ? process.geteuid() : os.userInfo().username), process.ppid + ".pipe");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" ? first : typeof first === "string" && !/^\\d+$/.test(first) ? { path: first }
    : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
  const event = { method: "connect", host: options?.host ?? options?.hostname ?? null, port: options?.port ?? null, path: options?.path ?? null };
  if (event.host === null && event.port === null && event.path === tsxPipe) {
    fs.appendFileSync(${JSON.stringify(ipcLog)}, JSON.stringify(event) + "\\n"); return Reflect.apply(connect, this, args);
  }
  return deny(event);
};
globalThis.fetch = input => {
  let url; try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); } catch {}
  return deny({ method: "fetch", host: url?.hostname ?? null, port: url?.port ?? null, path: url?.pathname ?? null });
};
require("node:module").syncBuiltinESMExports();\n`);
}, { timeout: 120_000 });

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  }
  assert.deepEqual(launchers.map(digest), launcherDigests, "The isolated build/runtime must not rewrite shared dependency launchers");
  rmSync(scratch, { recursive: true, force: true });
});

test("app image COPY inputs produce proposals assets and a runtime without executor sources", () => {
  assert.ok(existsSync(join(runtime, "app/main.ts")));
  assert.ok(existsSync(join(runtime, "web/dist/proposals.html")));
  for (const path of ["src/server.ts", "src/gateway/server.ts", "src/agent.ts", "src/dispatch.ts", ".env", ".app", ".ops", "test"])
    assert.equal(existsSync(join(runtime, path)), false, `App runtime must not ship ${path}`);
  for (const file of files(join(runtime, "web/dist"))) {
    const content = readFileSync(file).toString();
    assert.ok(!content.includes(credential) && !content.includes(secret), `Server secrets must not enter frontend asset ${relative(runtime, file)}`);
  }
});

test("the app service configuration selects its own image, entrypoint, health check and one replica", () => {
  const config = JSON.parse(readFileSync(join(root, "railway.app.json"), "utf8"));
  assert.equal(config.build.builder, "DOCKERFILE"); assert.equal(config.build.dockerfilePath, "Dockerfile.app");
  assert.equal(config.deploy.startCommand, "/app/deploy/app-entrypoint.sh");
  assert.equal(config.deploy.healthcheckPath, "/health"); assert.equal(config.deploy.numReplicas, 1);
  assert.equal(statSync(join(root, "deploy/app-entrypoint.sh")).mode & 0o111, 0o111, "The actual image entrypoint is executable");
  assert.match(readFileSync(join(root, "Dockerfile.app"), "utf8"), /^ENV .*APP_STATE=\/data\/app\b/m, "Durable claims use the service volume by default");
});

test("the real app entrypoint boots with only app configuration, serves proposals, and performs no provider reads", { timeout: 30_000 }, async () => {
  port = await availablePort();
  const env = runtimeEnv();
  for (const key of ["NEAR_INTENTS_AGENT_API_KEY", "NEARAI_API_KEY", "AGENT_ID", "AGENT_GRANT_TOKEN", "FASTNEAR_API_KEY", "ENV_FILE"])
    assert.equal(key in env, false, `No executor/provider setting is needed: ${key}`);
  child = spawn("/bin/sh", [join(runtime, "deploy/app-entrypoint.sh")], { cwd: runtime, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", value => { output += String(value); }); child.stderr!.on("data", value => { output += String(value); });
  await new Promise<void>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`App startup timed out:\n${output}`)), 15_000);
    child!.once("error", error => { clearTimeout(timeout); fail(error); });
    child!.once("exit", code => { clearTimeout(timeout); fail(new Error(`App exited before readiness (${code}):\n${output}`)); });
    child!.stdout!.on("data", () => { if (output.includes(`Treasury app on port ${port}`)) { clearTimeout(timeout); done(); } });
  });
  assert.deepEqual(JSON.parse((await call("/health")).body), { ok: true });
  const page = await call("/");
  assert.equal(page.status, 200); assert.match(page.contentType, /text\/html/);
  assert.equal(page.body, readFileSync(join(runtime, "web/dist/proposals.html"), "utf8"), "Root serves the actual proposals build");
  const assets = [...page.body.matchAll(/(?:src|href)=["'](\/static\/[^"']+)["']/g)].map(match => match[1]!);
  assert.ok(assets.some(path => path.endsWith(".js")), "The page loads real application scripts");
  for (const path of assets) assert.equal((await call(path)).status, 200, path);
  for (const path of ["/app/orders?organization=build-fixture&agent=portfolio", "/app/orders/consent?organization=build-fixture&agent=portfolio"])
    assert.equal((await call(path)).status, 401, path);
  for (const path of ["/app/orders/consent", "/app/connect/prepare", `/app/orders/${"a".repeat(32)}/place`])
    assert.equal((await call(path, { method: "POST" })).status, 401, path);
  for (const path of ["/gw/me", "/rpc/limitOrders/place", "/a/portfolio/rpc/limitOrders/place", "/index.html", "/recover"])
    assert.equal((await call(path)).status, 404, `No gateway or executor route: ${path}`);
  assert.equal((await call("/", { signingHost: "other.build.test" })).status, 421);
  for (const directory of ["requests", "decision-attempts", "order-requests", "order-attempts", "order-dao-votes", "order-dao-consents"]) {
    const path = join(state, directory);
    assert.ok(statSync(path).isDirectory(), `${directory} is retained under APP_STATE`);
    assert.equal(statSync(path).mode & 0o077, 0, "Private state is inaccessible to group/other accounts");
    assert.deepEqual(readdirSync(path), [], "Signed-out startup creates no consent, order or execution record");
  }
  assert.equal(existsSync(join(state, "tokens")), false, "Token storage is created only when an owner issues a token");
  assert.equal(existsSync(join(runtime, ".app")), false, "APP_STATE overrides the source working directory");
  assert.equal(readFileSync(join(state, "retained-state.txt"), "utf8"), retainedState, "Startup preserves existing app records");
  assert.equal(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "", "", "Startup and signed-out routes make no platform or provider calls");
  const expectedPipe = join(tmpdir(), `tsx-${process.geteuid ? process.geteuid() : userInfo().username}`, `${process.pid}.pipe`);
  const ipc = existsSync(ipcLog) ? readFileSync(ipcLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  assert.ok(ipc.every(event => event.method === "connect" && event.host === null && event.port === null && event.path === expectedPipe),
    "Only the observed tsx parent-loader Unix socket may connect; no TCP or other IPC is allowed");
  assert.ok(!output.includes(credential) && !output.includes(secret), "Startup never logs app secrets");
});

test("the real entrypoint refuses missing or invalid app configuration without printing secrets", () => {
  const cases: { key: string; value?: string }[] = [
    { key: "APP_HOST" }, { key: "PLATFORM_URL" }, { key: "TREASURY_APP_CREDENTIAL" }, { key: "SESSION_SECRET" },
    { key: "SESSION_SECRET", value: "short" }, { key: "PLATFORM_URL", value: "http://127.0.0.1:9" },
    { key: "PLATFORM_URL", value: "https://127.0.0.1:9/path" },
    { key: "APP_HOST", value: "app.invalid/path" }, { key: "PORT", value: "70000" },
    { key: "APP_STATE", value: "relative-state" }, { key: "APP_WEB_DIST", value: "relative-assets" },
  ];
  for (const scenario of cases) {
    const env: Record<string, string> = { ...runtimeEnv(), PORT: "0" };
    if (scenario.value === undefined) delete env[scenario.key]; else env[scenario.key] = scenario.value;
    const result = spawnSync("/bin/sh", [join(runtime, "deploy/app-entrypoint.sh")], { cwd: runtime, env, encoding: "utf8", timeout: 5_000 });
    assert.ok(result.status !== 0 && !result.error, `${scenario.key} must refuse immediately: ${result.error ?? ""}`);
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    assert.match(diagnostic, new RegExp(scenario.key), "The error names the configuration to fix");
    assert.ok(!diagnostic.includes(credential) && !diagnostic.includes(secret), "Configuration failures never echo secrets");
  }
  for (const mount of [undefined, "/wrong-mount", "/data"]) {
    const env: Record<string, string> = { ...runtimeEnv(), PORT: "0", RAILWAY_ENVIRONMENT_ID: "fixture-environment" };
    if (mount !== undefined) env.RAILWAY_VOLUME_MOUNT_PATH = mount;
    const result = spawnSync("/bin/sh", [join(runtime, "deploy/app-entrypoint.sh")], { cwd: runtime, env, encoding: "utf8", timeout: 5_000 });
    assert.ok(result.status !== 0 && !result.error, "Hosted startup requires the mounted volume and state under it");
    assert.match(result.stderr, mount === "/data" ? /APP_STATE/ : /persistent volume/);
    assert.ok(!result.stderr.includes(credential) && !result.stderr.includes(secret));
  }
  const escaped = spawnSync("/bin/sh", [join(runtime, "deploy/app-entrypoint.sh")], { cwd: runtime,
    env: { ...runtimeEnv(), PORT: "0", RAILWAY_ENVIRONMENT_ID: "fixture-environment", RAILWAY_VOLUME_MOUNT_PATH: "/data", APP_STATE: "/data/../tmp/ephemeral-app-state" },
    encoding: "utf8", timeout: 5_000 });
  assert.ok(escaped.status !== 0 && !escaped.error); assert.match(escaped.stderr, /APP_STATE/);
  assert.equal(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "", "", "Configuration validation performs no platform/provider calls");
});

test("the real entrypoint refuses incomplete built assets and preserves existing state", () => {
  const incomplete = join(scratch, "incomplete-assets");
  cpSync(join(runtime, "web/dist"), incomplete, { recursive: true });
  const page = readFileSync(join(incomplete, "proposals.html"), "utf8");
  const script = /\bsrc=["'](\/static\/[^"']+\.js)["']/.exec(page)?.[1];
  assert.ok(script, "Use a real script referenced by the proposals build");
  rmSync(join(incomplete, script));
  const result = spawnSync("/bin/sh", [join(runtime, "deploy/app-entrypoint.sh")], { cwd: runtime,
    env: { ...runtimeEnv(), APP_WEB_DIST: incomplete, PORT: "0" }, encoding: "utf8", timeout: 5_000 });
  assert.ok(result.status !== 0 && !result.error, `Missing assets must refuse before listening: ${result.error ?? ""}`);
  assert.match(result.stderr, /static asset.*missing|missing.*static asset/);
  assert.ok(!result.stdout.includes(credential) && !result.stderr.includes(credential) && !result.stderr.includes(secret));
  assert.equal(readFileSync(join(state, "retained-state.txt"), "utf8"), retainedState);
  assert.equal(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "", "");
});
