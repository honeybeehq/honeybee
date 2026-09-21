import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exposeDeployedCli } from "../src/deployCli.js";

test("deploy-owned CLI follows current, preserves argument quoting, and replays exposure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-cli-"));
  try {
    const root = join(dir, "hive's root", "runtime"), bin = join(dir, "local", "bin");
    await mkdir(join(root, "current", "dist"), { recursive: true });
    await writeFile(join(root, "current", "dist", "cli.js"), 'console.log(JSON.stringify({args:process.argv.slice(2),root:process.env.HIVE_STORE_ROOT,data:process.env.HIVE_V2_DATA_DIR}))');
    await exposeDeployedCli(root, bin, process.execPath);
    await exposeDeployedCli(root, bin, process.execPath);
    assert.equal(await readlink(join(bin, "hive")), join(root, "hive"));
    const { stdout } = await promisify(execFile)(join(bin, "hive"), ["status", "a'b $x"]);
    assert.deepEqual(JSON.parse(stdout), { args: ["status", "a'b $x"], root: join(dir, "hive's root"), data: join(dir, "hive's root", "v2") });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("deploy-owned CLI preserves an existing user command and dangling link", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-cli-"));
  try {
    const root = join(dir, "runtime"), bin = join(dir, "bin");
    await mkdir(root); await mkdir(bin); await writeFile(join(bin, "hive"), "user command");
    await exposeDeployedCli(root, bin, process.execPath);
    assert.equal(await readFile(join(bin, "hive"), "utf8"), "user command");
    await rm(join(bin, "hive")); await symlink("absent-user-command", join(bin, "hive"));
    await exposeDeployedCli(root, bin, process.execPath);
    assert.equal(await readlink(join(bin, "hive")), "absent-user-command");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
