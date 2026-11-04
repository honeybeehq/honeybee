import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { apiaryHarnessProjection, nodeReadOnlyProjection } from "../src/apiaryHarness.ts";

function fixture() {
  const root = mkdtempSync("/tmp/hb-projection-");
  const home = join(root, "home");
  const base = join(home, ".local", "share", "apiary-satellite");
  mkdirSync(join(base, "bin"), {recursive: true, mode: 0o700});
  const leaf = join(base, "tools", "codex", "1.2.3");
  mkdirSync(join(leaf, "bin"), {recursive: true, mode: 0o700});
  const executable = join(leaf, "bin", "codex");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", {mode: 0o700});
  symlinkSync(executable, join(base, "bin", "codex"));
  return {root, home, base, leaf, executable, command: join(base, "bin", "codex"), uid: process.geteuid!()};
}
const dispose = (root: string) => { try { rmSync(root, {recursive: true, force: true}); } catch (error) { console.error(error); process.exitCode = 1; } };

test("projection fixes the launched identity and refuses unsupported or missing leaves", () => {
  const f = fixture();
  try {
    const projection = apiaryHarnessProjection(f.command, [], f.home, f.uid)!;
    assert.equal(projection.leaf, f.leaf);
    assert.equal(projection.executable, f.executable);
    assert.equal(projection.alias, "/run/honeybee/tools/bin/codex");
    assert.equal(apiaryHarnessProjection("codex", [], f.home, f.uid)!.leaf, f.leaf);
    assert.equal(apiaryHarnessProjection("/usr/bin/node", [f.command], f.home, f.uid, "codex")!.leaf, f.leaf);
    const javascript = join(f.leaf, "bin", "codex.js");
    writeFileSync(javascript, "console.log('fixture')", {mode: 0o700});
    rmSync(f.command); symlinkSync(javascript, f.command);
    assert.equal(apiaryHarnessProjection("/usr/bin/node", [javascript], f.home, f.uid, "codex")!.executable, javascript);
    rmSync(f.command); symlinkSync(f.executable, f.command);
    assert.equal(apiaryHarnessProjection("/usr/bin/node", [], f.home, f.uid), null);
    assert.equal(apiaryHarnessProjection("/usr/bin/node", ["-e", "console.log(1)"], f.home, f.uid, "codex"), null);
    assert.throws(() => apiaryHarnessProjection(f.command, [], f.home, f.uid, "claude"), /identities disagree/);
    for (const name of ["grok", "opencode", "kimi", "muse", "unreviewed"]) assert.throws(() => apiaryHarnessProjection(join(f.base, "bin", name), [], f.home, f.uid), /excluded/);
    assert.throws(() => apiaryHarnessProjection("claude", [], f.home, f.uid), /approved Apiary-managed/);
    rmSync(f.leaf, {recursive: true});
    assert.throws(() => apiaryHarnessProjection(f.command, [], f.home, f.uid), /ENOENT/);
  } finally {dispose(f.root);}
});

test("projection refuses escaping links, unsafe permissions and an unapproved version", () => {
  const f = fixture();
  try {
    chmodSync(f.leaf, 0o770);
    assert.throws(() => apiaryHarnessProjection(f.command, [], f.home, f.uid), /writable/);
    chmodSync(f.leaf, 0o700);
    symlinkSync("/bin/sh", join(f.leaf, "escape"));
    assert.throws(() => apiaryHarnessProjection(f.command, [], f.home, f.uid), /escapes/);
    rmSync(join(f.leaf, "escape"));
    rmSync(f.command); symlinkSync("/bin/sh", f.command);
    assert.throws(() => apiaryHarnessProjection(f.command, [], f.home, f.uid), /approved Apiary-managed/);
    rmSync(f.command); symlinkSync(f.executable, f.command);
    const bad = join(f.base, "tools", "codex", "1.2.3.tmp", "codex");
    mkdirSync(dirname(bad), {recursive: true, mode: 0o700}); writeFileSync(bad, "fixture", {mode: 0o700});
    rmSync(f.command); symlinkSync(bad, f.command);
    assert.throws(() => apiaryHarnessProjection(f.command, [], f.home, f.uid), /approved Apiary-managed/);
  } finally {dispose(f.root);}
});

test("Node projection exposes only its fixed runtime and package set", () => {
  const root = mkdtempSync("/tmp/hb-node-projection-");
  try {
    mkdirSync(join(root, "bin"), {mode: 0o700});
    writeFileSync(join(root, "bin", "node"), "fixture", {mode: 0o700});
    writeFileSync(join(root, "bin", "extra-cli"), "fixture", {mode: 0o700});
    const npm = join(root, "lib", "node_modules", "npm");
    mkdirSync(join(npm, "bin"), {recursive: true, mode: 0o700});
    const launcher = join(npm, "bin", "npm-cli.js"); writeFileSync(launcher, "fixture", {mode: 0o700});
    symlinkSync(launcher, join(root, "bin", "npm"));
    const plan = nodeReadOnlyProjection(root, process.geteuid!());
    assert.deepEqual(plan.files, [join(root, "bin", "node")]);
    assert.deepEqual(plan.packages, [npm]);
    assert.deepEqual(plan.links, [{path: join(root, "bin", "npm"), target: launcher}]);
    rmSync(join(root, "bin", "npm")); symlinkSync("/bin/sh", join(root, "bin", "npm"));
    assert.throws(() => nodeReadOnlyProjection(root, process.geteuid!()), /launcher target/);
  } finally {dispose(root);}
});

test("projected executable and tools work while unrelated fixture state stays hidden", {skip: process.platform !== "linux"}, () => {
  const f = fixture();
  try {
    const actualHome = userInfo().homedir;
    const virtualBase = join(actualHome, ".local", "share", "apiary-satellite");
    rmSync(f.command); symlinkSync(join(virtualBase, "tools", "codex", "1.2.3", "bin", "codex"), f.command);
    writeFileSync(join(f.home, ".projection-fixture"), "owned fixture", {mode: 0o600});
    writeFileSync(join(f.base, "private-marker"), "fixture", {mode: 0o600});
    mkdirSync(join(f.base, "tools", "claude", "9.9.9"), {recursive: true, mode: 0o700});
    writeFileSync(f.executable, `#!/bin/sh\nset -eu\nnode --version\nprintf 'PATH=%s\\n' "$PATH"\ntest ! -e '${virtualBase}/private-marker'\ntest ! -e '${virtualBase}/tools/claude'\nif touch '${virtualBase}/tools/codex/1.2.3/poison' 2>/dev/null; then exit 19; fi\nprintf 'projection-fixture-ok\\n'\n`, {mode: 0o700});
    const executable = realpathSync(process.execPath);
    const install = dirname(dirname(executable));
    assert.match(install, /^\/opt\/node-v[0-9]+\.[0-9]+\.[0-9]+-linux-(?:x64|arm64)$/);
    const overlay = join(f.root, "node"); mkdirSync(join(overlay, "bin"), {recursive: true, mode: 0o755});
    copyFileSync(executable, join(overlay, "bin", "node")); chmodSync(join(overlay, "bin", "node"), 0o755); chmodSync(overlay, 0o755); chmodSync(join(overlay, "bin"), 0o755);
    writeFileSync(join(overlay, "bin", "extra-cli"), "fixture", {mode: 0o700});
    mkdirSync(join(overlay, "lib", "node_modules", "extra-package"), {recursive: true, mode: 0o700});
    writeFileSync(join(overlay, "lib", "node_modules", "extra-package", "marker"), "fixture", {mode: 0o600});
    mkdirSync(join(overlay, "include"), {mode: 0o700});
    writeFileSync(join(overlay, "include", "marker"), "fixture", {mode: 0o600});
    const checkout = fileURLToPath(new URL("../../..", import.meta.url));
    const worker = fileURLToPath(new URL("./fixtures/apiary-harness-projection.mjs", import.meta.url));
    const temp = join(f.root, "temp"); mkdirSync(temp);
    const args = ["--unshare-user", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--bind", f.home, actualHome, "--ro-bind", checkout, checkout, "--ro-bind", overlay, install, "--bind", temp, "/tmp", "--", executable, worker];
    const result = spawnSync("bwrap", args, {encoding: "utf8", timeout: 30000, env: {PATH: "/usr/bin:/bin", HOME: actualHome, LANG: "C.UTF-8"}});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(join(f.leaf, "poison")), false);
    assert.equal(readFileSync(join(f.base, "private-marker"), "utf8"), "fixture");
    console.log(result.stdout.trim());
  } finally {dispose(f.root);}
});
