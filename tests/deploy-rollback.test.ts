import { backupStoreOffline } from "../v2/core/src/storeBackup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashDirectoryTree } from "../src/deploySettle.js";
import { assertRollbackStoreCompatible, currentDeployTarget, DeployRollbackError, readDeployHistory, rollbackDeploy } from "../src/deployRuntime.js";

const current = "a".repeat(40), previous = "b".repeat(40);
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hb-rollback-logic-"));
  const root = join(dir, "runtime"), external = join(dir, "apiary", "content-address", "honeybee");
  await mkdir(join(external, "dist", "v2"), { recursive: true });
  await writeFile(join(external, "dist", "cli.js"), "");
  await writeFile(join(external, "dist", "v2", "cli.js"), "var SCHEMA_VERSION = 44;\n");
  await mkdir(join(root, previous, "dist", "v2"), { recursive: true });
  await writeFile(join(root, previous, "dist", "cli.js"), "");
  await writeFile(join(root, previous, "dist", "v2", "cli.js"), "var SCHEMA_VERSION = 44;\n");
  await writeFile(join(external, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, component: "honeybee", version: "0.1.0", packageVersion: "0.1.0", sourceRevision: current, dirty: false, release: true, target: "linux-x64" }));
  await symlink(external, join(root, "current"));
  await writeFile(join(root, "deploys.json"), JSON.stringify({ schemaVersion: 1, entries: [{ sha: previous, artifactHash: "old", at: "2026-10-22T00:00:00Z", by: "fixture" }, { sha: current, artifactHash: await hashDirectoryTree(join(external, "dist")), at: "2026-10-22T01:00:00Z", by: "fixture" }] }));
  return { dir, root, external };
}

for (const fail of [false, true]) test(`external Apiary current reconciles history and ${fail ? "restores its exact link on failure" : "rolls back to an installed history build"}`, async () => {
  const f = await fixture();
  try {
    assert.equal(await currentDeployTarget(f.root), current);
    const history = await readDeployHistory(f.root);
    const operation = rollbackDeploy({ root: f.root, hooks: { async restartDaemon(context) {
      assert.equal(await readlink(join(f.root, "current")), previous);
      if (fail) { await context.restorePrevious?.(); throw new Error("activation failed"); }
    } } });
    if (fail) {
      await assert.rejects(operation, /activation failed/);
      assert.equal(await readlink(join(f.root, "current")), f.external);
      assert.deepEqual(await readDeployHistory(f.root), history);
    } else {
      assert.equal((await operation).from, current);
      assert.equal(await currentDeployTarget(f.root), previous);
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("unidentified external runtime refuses with the missing identity path", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.external, "dist", "build-identity.json"), "{}");
    await assert.rejects(rollbackDeploy({ root: f.root, hooks: { async restartDaemon() { assert.fail(); } } }), error => error instanceof DeployRollbackError && error.code === "ROLLBACK_CURRENT_IDENTITY_MISSING" && /build-identity.json/.test(error.message));
    assert.equal(await readlink(join(f.root, "current")), f.external);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const schema of [44, 48]) test(`rollback checks store schema ${schema} before changing current or history`, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, "v2"));
    const db = new DatabaseSync(join(f.dir, "v2", "core.sqlite3"));
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO meta VALUES('schema_version',?)").run(String(schema));
    db.close();
    const history = await readFile(join(f.root, "deploys.json"));
    let restarted = false;
    let backedUp = false;
    const operation = rollbackDeploy({ root: f.root, hooks: {
      async backupStore() {
        assert.equal(await readlink(join(f.root, "current")), f.external);
        backedUp = true;
        return backupStoreOffline(join(f.dir, "v2", "core.sqlite3"), "rollback-fixture");
      },
      async restartDaemon() { restarted = true; },
    } });
    if (schema === 44) { await operation; assert.equal(restarted, true); assert.equal(backedUp, true); }
    else {
      await assert.rejects(operation, error => error instanceof DeployRollbackError && error.code === "ROLLBACK_STORE_RESTORE_REQUIRED" && /store restore --from/.test(error.message));
      assert.equal(restarted, false);
      assert.equal(backedUp, false);
      assert.equal(await readlink(join(f.root, "current")), f.external);
      assert.deepEqual(await readFile(join(f.root, "deploys.json")), history);
    }
    await writeFile(join(f.root, previous, "dist", "v2", "cli.js"), "");
    await assert.rejects(assertRollbackStoreCompatible(f.root, join(f.root, previous)), error => error instanceof DeployRollbackError && error.code === "ROLLBACK_SCHEMA_UNKNOWN");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const bundle of ["", "var SCHEMA_VERSION = 48;\nvar SCHEMA_VERSION2 = 48;\n", "var SCHEMA_VERSION = garbage;\n"]) test(`unknown schema capability refuses: ${JSON.stringify(bundle)}`, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, "v2"));
    await writeFile(join(f.dir, "v2", "core.sqlite3"), "unreadable sqlite");
    await writeFile(join(f.root, previous, "dist", "v2", "cli.js"), bundle);
    await assert.rejects(assertRollbackStoreCompatible(f.root, join(f.root, previous)), error => error instanceof DeployRollbackError && error.code === "ROLLBACK_SCHEMA_UNKNOWN");
    await writeFile(join(f.root, previous, "dist", "v2", "cli.js"), "var SCHEMA_VERSION = 48;\n");
    await assert.rejects(assertRollbackStoreCompatible(f.root, join(f.root, previous)), error => error instanceof DeployRollbackError && error.code === "ROLLBACK_SCHEMA_UNKNOWN");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("schema 29 requires an explicit store restore even when the target schema is newer", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, "v2"));
    const db = new DatabaseSync(join(f.dir, "v2", "core.sqlite3"));
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('schema_version','29')");
    db.close();
    await assert.rejects(assertRollbackStoreCompatible(f.root, join(f.root, previous)), error => error instanceof DeployRollbackError && error.code === "ROLLBACK_STORE_RESTORE_REQUIRED");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("rollback from an external current retains it for a second rollback back", async () => {
  const f = await fixture();
  try {
    const hooks = { async restartDaemon() {} };
    assert.equal((await rollbackDeploy({ root: f.root, hooks })).sha, previous);
    assert.equal((await rollbackDeploy({ root: f.root, hooks })).sha, current);
    assert.equal(await readlink(join(f.root, "current")), current);
    assert.deepEqual(await readFile(join(f.root, current, "dist", "build-identity.json")), await readFile(join(f.external, "dist", "build-identity.json")));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
