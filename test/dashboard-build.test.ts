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


test("images install @multiagency/sdk from the registry at an exact version, with no working-tree link or extra build context", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const specs = { ...manifest.dependencies, ...manifest.devDependencies } as Record<string, string>;
  assert.match(specs["@multiagency/sdk"] ?? "", /^\d+\.\d+\.\d+$/, "pin @multiagency/sdk to one published version");
  for (const [name, spec] of Object.entries(specs)) assert.ok(!/^(link|file|portal):/.test(spec), `${name} must not be a working-tree dependency`);
  for (const name of ["Dockerfile", "Dockerfile.dashboard", "Dockerfile.legacy-invoices"])
    assert.doesNotMatch(readFileSync(join(root, name), "utf8"), /^COPY --from=/m, `${name} must build from this repository alone`);
});
