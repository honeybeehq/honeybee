import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { assertDeployNodePolicy } from "../src/commands/deploy.js";

test("deploy node policy parses fresh target fixtures and respects explicit policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-node-policy-"));
  try {
    const dataDir = join(root, "v2");
    await mkdir(dataDir);
    assert.throws(() => assertDeployNodePolicy(dataDir, "linux"), /configure nodeKind or cells.sandbox/);
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
      const on = config.cells?.sandbox ?? config.nodeKind === "satellite";
      if (on) assert.throws(() => assertDeployNodePolicy(dataDir, "darwin"), /unsupported private Claude\/Codex/);
      else assert.doesNotThrow(() => assertDeployNodePolicy(dataDir, "darwin"));
      assert.equal(await readFile(join(dataDir, "config.json"), "utf8"), raw);
    }
    for (const raw of ["{", "null", "[]", '{"nodeKind":"typo"}', '{"cells":{"sandbox":null}}', '{"cells":{"sandbox":"false"}}', '{"cells":false}']) {
      await writeFile(join(dataDir, "config.json"), raw);
      assert.throws(() => assertDeployNodePolicy(dataDir, "linux"), /config:/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deploy CLI refuses all installation paths before artifact reads or runtime writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-node-cli-"));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, ["tests/cli-entry.mjs", "deploy", ...args], {
    env: { ...process.env, HIVE_STORE_ROOT: root, NO_COLOR: "1", TERM: "dumb" },
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
  } finally { await rm(root, { recursive: true, force: true }); }
});
