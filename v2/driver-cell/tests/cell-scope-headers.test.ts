import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Cell scope compiles with pre-ABI6 Landlock headers and keeps the live ABI query", {skip: process.platform !== "linux"}, () => {
  const root = mkdtempSync(join(tmpdir(), "hb-scope-headers-"));
  try {
    mkdirSync(join(root, "linux"));
    writeFileSync(join(root, "linux", "landlock.h"), '#include <stdint.h>\nstruct landlock_ruleset_attr { uint64_t handled_access_fs; uint64_t handled_access_net; };\n#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)\n');
    const source = fileURLToPath(new URL("../native/cell-scope.c", import.meta.url));
    const binary = join(root, "cell-scope");
    const build = spawnSync(process.env.CC ?? "cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-I", root, source, "-o", binary], {encoding: "utf8"});
    assert.equal(build.status, 0, build.stderr);
    const abi = spawnSync(binary, ["--abi"], {encoding: "utf8"});
    assert.equal(abi.status, 0, abi.stderr);
    assert.match(abi.stdout.trim(), /^[0-9]+$/);
    const run = spawnSync(binary, ["--", "/bin/true"], {encoding: "utf8"});
    if (Number(abi.stdout.trim()) < 6) {
      assert.equal(run.status, 125);
      assert.match(run.stderr, /ABI >= 6 required/);
    } else assert.equal(run.status, 0, run.stderr);
  } finally {
    const trash = join(tmpdir(), "honeybee-test-trash");
    mkdirSync(trash, {recursive: true, mode: 0o700});
    assert.equal(spawnSync("trash", ["--trash-dir", trash, root]).status, 0);
  }
});
