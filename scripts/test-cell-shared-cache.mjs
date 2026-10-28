import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux");
const checkout = fileURLToPath(new URL("..", import.meta.url));
const executable = realpathSync(process.execPath);
const install = dirname(dirname(executable));
assert.match(install, /^\/opt\/node-v[0-9]+\.[0-9]+\.[0-9]+-linux-(?:x64|arm64)$/);
const root = mkdtempSync(join(tmpdir(), "hb-shared-cache-venue-"));
try {
  const overlay = join(root, "node");
  mkdirSync(join(overlay, "bin"), {recursive:true});
  mkdirSync(join(root, "temp")); mkdirSync(join(root, "data"));
  const copy = join(overlay, "bin", basename(executable));
  copyFileSync(executable, copy);
  for (const path of [overlay, join(overlay, "bin"), copy]) chmodSync(path, 0o755);
  const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(hash(copy), hash(executable));
  assert.equal(statSync(overlay).uid, process.geteuid());
  const args = ["--unshare-user", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
    "--tmpfs", homedir(), "--ro-bind", checkout, checkout,
    "--bind", root, "/mnt", "--bind", join(root, "temp"), "/tmp", "--ro-bind", overlay, install,
    "--setenv", "TMPDIR", "/tmp", "--setenv", "XDG_DATA_HOME", "/mnt/data", "--setenv", "HIVE_TEST_SHARED_CACHE_ROOT", "/tmp", "--unsetenv", "NODE_COMPILE_CACHE",
    "--", executable, "--test", "v2/driver-cell/tests/shared-cache.test.ts"];
  const result = spawnSync("bwrap", args, {cwd:checkout, stdio:"inherit", timeout:30000});
  assert.equal(result.error?.code, undefined);
  assert.equal(result.status, 0);
} finally {
  const trash = join(tmpdir(), "honeybee-test-trash");
  mkdirSync(trash, {recursive:true, mode:0o700});
  assert.equal(spawnSync("trash", ["--trash-dir", trash, root], {stdio:"inherit"}).status, 0);
  console.log(JSON.stringify({fixture:"T11 shared cache venue", cleanup:"owned fixture tree trashed"}));
}
