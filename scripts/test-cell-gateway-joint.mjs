import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux", "Joint gateway confinement requires Linux");
const checkout = fileURLToPath(new URL("..", import.meta.url));
const executable = realpathSync(process.execPath);
const install = dirname(dirname(executable));
assert.match(install, /^\/opt\/node-v[0-9]+\.[0-9]+\.[0-9]+-linux-(?:x64|arm64)$/);
const root = mkdtempSync(join(tmpdir(), "hb-gateway-joint-"));
try {
  const overlay = join(root, "node");
  mkdirSync(join(overlay, "bin"), { recursive: true });
  mkdirSync(join(root, "temp"));
  const copy = join(overlay, "bin", basename(executable));
  copyFileSync(executable, copy);
  for (const path of [overlay, join(overlay, "bin"), copy]) chmodSync(path, 0o755);
  const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  const sourceHash = hash(executable);
  assert.equal(hash(copy), sourceHash);
  assert.equal(statSync(overlay).uid, process.geteuid());
  console.log(JSON.stringify({ fixture: "owned-node-code-overlay", node: process.version, sha256: sourceHash, credentialsCopied: false }));
  for (const custom of [false, true]) {
    const args = ["--unshare-user", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
      "--bind", root, "/mnt", "--bind", join(root, "temp"), "/tmp", "--ro-bind", overlay, install,
      "--setenv", "TMPDIR", custom ? "/mnt" : "/tmp", "--unsetenv", "NODE_COMPILE_CACHE",
      ...(custom ? ["--setenv", "HIVE_TEST_GATEWAY_CUSTOM_ROOT", "1"] : ["--unsetenv", "HIVE_TEST_GATEWAY_CUSTOM_ROOT"]),
      "--", executable, "--test", "v2/daemon/tests/cell-gateway-sandbox.test.ts"];
    const result = spawnSync("bwrap", args, { cwd: checkout, stdio: "inherit", timeout: 60_000 });
    assert.equal(result.error?.code, undefined, "Outer fixture launcher must start");
    assert.equal(result.status, 0, custom ? "Custom daemon home fixture" : "Default daemon home fixture");
  }
} finally {
  const trashDirectory = join(tmpdir(), "honeybee-test-trash");
  mkdirSync(trashDirectory, { recursive: true, mode: 0o700 });
  const cleanup = spawnSync("trash", ["--trash-dir", trashDirectory, root], { stdio: "inherit" });
  assert.equal(cleanup.status, 0, "Only the test-owned fixture tree is trashed");
}
