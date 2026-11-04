import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { assertDeployNodePolicy, assertDeployTargetPolicy, rollbackRequiresNodePolicy } from "../src/commands/deploy.js";

async function trashFixture(root: string): Promise<void> {
  const trash = join(tmpdir(), "honeybee-test-trash");
  await mkdir(trash, {recursive: true, mode: 0o700});
  await rename(root, join(trash, basename(root)));
}

test("deploy node policy parses fresh target fixtures and respects explicit policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-node-policy-"));
  try {
    const dataDir = join(root, "v2");
    await mkdir(dataDir);
    assert.throws(() => assertDeployNodePolicy(dataDir, "linux"), /configure nodeKind or cells.sandbox/);
    assert.throws(() => assertDeployNodePolicy(dataDir, "linux"), (error: unknown) => error instanceof Error && "code" in error && error.code === "DEPLOY_NODE_POLICY_REQUIRED");
    for (const config of [{}, { agents: {} }]) {
      await writeFile(join(dataDir, "config.json"), JSON.stringify(config));
      assert.throws(() => assertDeployNodePolicy(dataDir, "linux"), /configure nodeKind or cells.sandbox/);
    }
    for (const config of [
      { nodeKind: "workstation" }, { nodeKind: "satellite" },
      { cells: { sandbox: false } }, { cells: { sandbox: true } },
      { nodeKind: "satellite", cells: { sandbox: false } },
      { nodeKind: "workstation", cells: { sandbox: true } },
    ]) {
      const raw = JSON.stringify(config);
      await writeFile(join(dataDir, "config.json"), raw);
      assert.doesNotThrow(() => assertDeployNodePolicy(dataDir, "linux"));
      const on = config.cells?.sandbox === true || (config.nodeKind === "satellite" && config.cells?.sandbox !== false);
      if (on) assert.throws(() => assertDeployNodePolicy(dataDir, "darwin"), (error: unknown) => error instanceof Error && "code" in error && error.code === "DEPLOY_DARWIN_SANDBOX_UNSUPPORTED");
      else assert.doesNotThrow(() => assertDeployNodePolicy(dataDir, "darwin"));
      assert.equal(await readFile(join(dataDir, "config.json"), "utf8"), raw);
    }
    for (const raw of ["{", "null", "[]", '{"nodeKind":"typo"}', '{"cells":{"sandbox":null}}', '{"cells":{"sandbox":"false"}}', '{"cells":false}']) {
      await writeFile(join(dataDir, "config.json"), raw);
      assert.throws(() => assertDeployNodePolicy(dataDir, "linux"), /config:/);
    }
  } finally { await trashFixture(root); }
});

test("deploy CLI refuses all installation paths before artifact reads or runtime writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-node-cli-"));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, ["tests/cli-entry.mjs", "deploy", ...args], {
    env: { ...process.env, HIVE_STORE_ROOT: root, HIVE_V2_DATA_DIR: join(root, "v2"), NO_COLOR: "1", TERM: "dumb" },
  });
  try {
    for (const args of [[], ["--rollback"], ["--artifact", "/missing/archive", "--identity", "/missing/identity", "--admission", "/missing/admission", "--expected-current", "none"]]) {
      await assert.rejects(run(...args), (error: unknown) => {
        assert.match((error as { stderr: string }).stderr, /configure nodeKind or cells.sandbox/);
        return true;
      });
      assert.deepEqual(await readdir(root), []);
    }
    for (const args of [["--help"], ["--list"], ["--init"]]) {
      const { stdout } = await run(...args);
      assert.ok(stdout.length > 0);
      assert.deepEqual(await readdir(root), []);
    }
  } finally { await trashFixture(root); }
});

test("deploy preflight resolves custom daemon config and refuses uncoordinated targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-target-policy-"));
  try {
    const dataDir = join(root, "v2"), custom = join(root, "custom"), runtime = join(root, "runtime");
    await mkdir(dataDir);
    await mkdir(custom);
    await writeFile(join(dataDir, "config.json"), JSON.stringify({ cells: { sandbox: false } }));
    await writeFile(join(custom, "config.json"), JSON.stringify({ nodeKind: "satellite" }));
    assert.doesNotThrow(() => assertDeployTargetPolicy(runtime, "linux", { dataDir }));
    assert.throws(() => assertDeployTargetPolicy(runtime, "linux", { dataDir: custom }), { code: "DEPLOY_CONFIG_TARGET_UNCOORDINATED" });
    assert.throws(() => assertDeployTargetPolicy(runtime, "linux", { dataDir: custom }, false), { code: "DEPLOY_CONFIG_TARGET_UNCOORDINATED" });
    await writeFile(join(dataDir, "config.json"), "{}");
    assert.doesNotThrow(() => assertDeployTargetPolicy(runtime, "linux", { dataDir }, false));
    assert.throws(() => assertDeployTargetPolicy(runtime, "linux", { dataDir }), { code: "DEPLOY_NODE_POLICY_REQUIRED" });
    const customConfig = join(root, "custom-config.json");
    await writeFile(customConfig, JSON.stringify({ cells: { sandbox: true } }));
    assert.throws(() => assertDeployNodePolicy(dataDir, "darwin", customConfig), { code: "DEPLOY_DARWIN_SANDBOX_UNSUPPORTED" });
    assert.throws(() => assertDeployTargetPolicy(runtime, "linux", { dataDir, configPath: customConfig }), { code: "DEPLOY_CONFIG_TARGET_UNCOORDINATED" });
    await writeFile(customConfig, "{");
    assert.throws(() => assertDeployTargetPolicy(runtime, "linux", { dataDir, configPath: customConfig }), /not valid json/);
    const result = await promisify(execFile)(process.execPath, ["tests/cli-entry.mjs", "deploy"], {
      env: { ...process.env, HIVE_STORE_ROOT: root, HIVE_V2_DATA_DIR: custom, NO_COLOR: "1" },
    }).then(() => "unexpected success", (error: { stderr: string }) => error.stderr);
    assert.match(result, /resolved daemon config differs/);
    assert.deepEqual(await readdir(root), ["custom", "custom-config.json", "v2"]);
  } finally { await trashFixture(root); }
});

test("rollback policy reads only the selected installed target's T11 marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-rollback-policy-"));
  try {
    const old = "a".repeat(40), current = "b".repeat(40);
    const target = join(root, old, "dist", "v2"), currentDir = join(root, current, "dist", "v2");
    await mkdir(target, { recursive: true });
    await mkdir(currentDir, { recursive: true });
    await writeFile(join(root, old, "dist", "cli.js"), "fixture");
    await symlink(current, join(root, "current"));
    await writeFile(join(root, "deploys.json"), JSON.stringify({ entries: [old, current].map(sha => ({ sha, at: "2026-11-04T00:00:00Z", artifactHash: "1".repeat(64), by: "fixture" })) }));
    await writeFile(join(currentDir, "cell-cli-manifest.json"), "{}");
    assert.equal(await rollbackRequiresNodePolicy(root), false);
    await writeFile(join(target, "cell-cli-manifest.json"), "{}");
    assert.equal(await rollbackRequiresNodePolicy(root), true);
    await writeFile(join(target, "cell-cli-manifest.json"), "invalid");
    assert.equal(await rollbackRequiresNodePolicy(root), true);
    await rename(join(target, "cell-cli-manifest.json"), join(target, "saved-manifest"));
    await symlink("missing", join(target, "cell-cli-manifest.json"));
    assert.equal(await rollbackRequiresNodePolicy(root), true);
    await rename(target, `${target}-saved`);
    await symlink(`${target}-saved`, target);
    assert.equal(await rollbackRequiresNodePolicy(root), true);
    await rename(join(root, "deploys.json"), join(root, "saved-deploys.json"));
    assert.equal(await rollbackRequiresNodePolicy(root), true);
  } finally { await trashFixture(root); }
});
