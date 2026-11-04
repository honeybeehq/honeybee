import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { rmSync, chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux", "Joint gateway confinement requires Linux");
const checkout = fileURLToPath(new URL("..", import.meta.url));
const executable = realpathSync(process.execPath);
const install = dirname(dirname(executable));
assert.match(install, /^\/opt\/node-v[0-9]+\.[0-9]+\.[0-9]+-linux-(?:x64|arm64)$/);
const root = mkdtempSync(join(tmpdir(), "hb-gateway-joint-"));
const suites = process.argv.includes("--sandbox-suites");
const secret = process.argv.includes("--secret-sandbox");
const beeTmp = process.argv.includes("--bee-tmp");
const realHome = process.argv.includes("--real-home-probe");
const composition = process.argv.includes("--composition");
const codex = process.argv.includes("--codex-fixture");
try {
  const overlay = join(root, "node");
  mkdirSync(join(overlay, "bin"), { recursive: true });
  mkdirSync(join(root, "temp"));
  mkdirSync(join(root, "data"));
  const copy = join(overlay, "bin", basename(executable));
  copyFileSync(executable, copy);
  for (const path of [overlay, join(overlay, "bin"), copy]) chmodSync(path, 0o755);
  if (codex) {
    cpSync(join(install, "lib", "node_modules", "@openai", "codex"), join(overlay, "lib", "node_modules", "@openai", "codex"), {recursive: true});
    symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", join(overlay, "bin", "codex"));
  }
  const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  const sourceHash = hash(executable);
  assert.equal(hash(copy), sourceHash);
  assert.equal(statSync(overlay).uid, process.geteuid());
  console.log(JSON.stringify({ fixture: "owned-node-code-overlay", node: process.version, sha256: sourceHash, credentialsCopied: false }));
  for (const custom of suites || codex || secret || beeTmp || realHome ? [false] : [false, true]) {
    const args = ["--unshare-user", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
      "--bind", root, "/mnt", "--bind", join(root, "temp"), "/tmp", "--ro-bind", overlay, install,
      "--setenv", "TMPDIR", custom ? "/mnt" : "/tmp", "--unsetenv", "NODE_COMPILE_CACHE",
      "--setenv", "XDG_DATA_HOME", "/mnt/data",
      ...(secret ? ["--setenv", "HIVE_TEST_SECRET_ROOT", "/mnt"] : []),
      ...(custom ? ["--setenv", "HIVE_TEST_GATEWAY_CUSTOM_ROOT", "1"] : ["--unsetenv", "HIVE_TEST_GATEWAY_CUSTOM_ROOT"]),
      "--", executable, ...(codex ? ["scripts/probe-cell-codex.mjs", join(install, "bin", "codex")] : ["--test", ...(realHome ? ["v2/driver-cell/tests/real-home-write.test.ts"] : beeTmp ? ["v2/daemon/tests/bee-tmp.test.ts"] : secret ? ["v2/driver-cell/tests/secret-sandbox.test.ts"] : suites ? ["v2/driver-cell/tests/sandbox-hardening.test.ts", "v2/driver-cell/tests/sandbox.test.ts", "v2/driver-cell/tests/driver.test.ts"] : [composition ? "v2/daemon/tests/confined-cell-gateway-composition.test.ts" : "v2/daemon/tests/cell-gateway-sandbox.test.ts"])])];
    const result = spawnSync("bwrap", args, { cwd: checkout, stdio: "inherit", timeout: suites || beeTmp ? 240_000 : 60_000 });
    assert.equal(result.error?.code, undefined, "Outer fixture launcher must start");
    assert.equal(result.status, 0, custom ? "Custom daemon home fixture" : "Default daemon home fixture");
  }
} finally {
  try { rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); } catch (error) { console.error("owned fixture cleanup failed", error); process.exitCode = 1; }
}
