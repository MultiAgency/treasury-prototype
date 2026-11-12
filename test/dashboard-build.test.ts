import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Exercise the actual bundler with only source inputs copied before the Docker build step.
// This is a build-input check, not a Linux image or runtime validation.
test("dashboard Dockerfile copies every source needed for its web build", { timeout: 60_000 }, () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const launcher = join(root, "node_modules/.bin/rsbuild");
  const launcherHash = () => createHash("sha256").update(readFileSync(launcher)).digest("hex");
  const launcherBefore = launcherHash();
  const dir = mkdtempSync(join(tmpdir(), "dashboard-build-"));
  try {
    const dockerfile = readFileSync(join(root, "Dockerfile.dashboard"), "utf8");
    const beforeBuild = dockerfile.split(/^RUN pnpm build:web$/m);
    assert.equal(beforeBuild.length, 2, "Locate the dashboard build boundary explicitly");
    for (const line of beforeBuild[0]!.split("\n")) {
      if (!line.startsWith("COPY ")) continue;
      const parts = line.slice(5).trim().split(/\s+/);
      const destination = parts.pop()!;
      assert.ok(!parts.some(part => /[\[\]*]/.test(part)), "Update fixture for complex COPY syntax");
      for (const source of parts) cpSync(join(root, source), join(dir, destination === "./" ? basename(source) : destination), {
        recursive: true, filter: path => !["node_modules", "dist"].includes(basename(path)),
      });
    }
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    // pnpm in a relocated fixture can rewrite the shared .bin shims. Run the same bundler directly.
    const result = spawnSync(process.execPath, [join(root, "node_modules/@rsbuild/core/bin/rsbuild.js"), "build", "--root", "web"],
      { cwd: dir, encoding: "utf8", timeout: 45_000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    assert.equal(launcherHash(), launcherBefore, "The isolated build must not rewrite shared dependency launchers");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("images pin the legacy SDK and the verified portable order-consumer artifact without working-tree links", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const specs = { ...manifest.dependencies, ...manifest.devDependencies } as Record<string, string>;
  assert.equal(specs["@multiagency/sdk"], "0.4.0", "legacy consumers keep their existing exact published SDK pin");
  const candidate = "vendor/multiagency-sdk-0.5.8.tgz";
  assert.equal(specs["@multiagency/treasury-app-sdk"], `file:${candidate}`, "the vendored candidate is a portable file, never an absolute checkout path");
  assert.equal(createHash("sha256").update(readFileSync(join(root, candidate))).digest("hex"),
    "844fae568516dbc8d377d6f8dcceb8177be8a92c134db545d024ac25cf45d254", "the frozen consumer build is exactly the verified handoff artifact");
  assert.equal(readFileSync(join(root, `${candidate}.sha256`), "utf8").trim(),
    "844fae568516dbc8d377d6f8dcceb8177be8a92c134db545d024ac25cf45d254  multiagency-sdk-0.5.8.tgz", "the portable checksum sidecar names these exact bytes");
  const packed = spawnSync("tar", ["-xOf", join(root, candidate), "package/provenance.json"], { encoding: "utf8" });
  assert.equal(packed.status, 0, `${packed.error ?? ""}\n${packed.stderr}`);
  const provenance = JSON.parse(packed.stdout);
  assert.equal(provenance.name, "@multiagency/sdk");
  assert.equal(provenance.version, "0.5.8");
  assert.equal(provenance.sourceHead, "2326a89505b7cb4996820467856de01165f881c6", "source is the reviewed platform commit");
  assert.equal(provenance.snapshot.runDigest, "6ce0914b10e83ffd74714b5356fee4d45699ce96f88cf96270bd524ca485f0fa", "source snapshot matches the frozen handoff");
  assert.equal(provenance.snapshot.overlayDiffSha256, null);
  assert.deepEqual(provenance.dirtyPaths, []);
  assert.deepEqual(provenance.sourcesDirty, []);
  for (const [name, spec] of Object.entries(specs)) if (name !== "@multiagency/treasury-app-sdk")
    assert.ok(!/^(link|file|portal):/.test(spec), `${name} must not be a working-tree dependency`);
  for (const name of ["Dockerfile", "Dockerfile.dashboard", "Dockerfile.legacy-invoices"]) {
    const dockerfile = readFileSync(join(root, name), "utf8");
    assert.doesNotMatch(dockerfile, /^COPY --from=/m, `${name} must build from this repository alone`);
    const artifactCopy = dockerfile.indexOf(`COPY ${candidate}`), install = dockerfile.indexOf("RUN pnpm install");
    assert.ok(artifactCopy >= 0 && install >= 0 && artifactCopy < install, `${name} copies the verified artifact before installing`);
  }
});
