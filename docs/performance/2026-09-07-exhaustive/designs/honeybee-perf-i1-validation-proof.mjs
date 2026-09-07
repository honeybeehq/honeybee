import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = process.argv[2];
assert.ok(root, "usage: node proof.mjs ROOT");
const { openCoreStore } = await import(pathToFileURL(join(root, "v2/core/src/index.ts")).href);

const probe = new DatabaseSync(":memory:");
const returnArrays = typeof probe.prepare("SELECT 1").setReturnArrays;
probe.close();

const dir = mkdtempSync(join(tmpdir(), "hb-i1-validation-"));
const path = join(dir, "core.sqlite3");
let store = openCoreStore(path, { ephemeral: true });
try {
  const created = store.createBee({
    id: "validation-bee",
    name: "validation-bee",
    agent: "stub",
    substrate: "hsr",
    cwd: "/tmp",
  });
  const message = store.send(created.bee.id, "body-must-not-project", { urgency: "next" }).message;
  store.close();

  const fixture = new DatabaseSync(path);
  try {
    fixture.exec("PRAGMA ignore_check_constraints = ON");
    fixture.prepare("UPDATE mailbox SET urgency = 'invalid' WHERE id = ?").run(message.id);
  } finally {
    fixture.close();
  }

  store = openCoreStore(path, { ephemeral: true });
  const expected = "daemon projection: malformed pending urgency";
  assert.throws(() => store.readI1PendingSnapshot(), (error) => {
    assert.equal(error?.name, "CoreError");
    assert.equal(error?.message, expected);
    return true;
  });
  assert.throws(() => store.readDaemonWork(), (error) => {
    assert.equal(error?.name, "CoreError");
    assert.equal(error?.message, expected);
    return true;
  });
  console.log(JSON.stringify({
    node: process.version,
    sqlite: process.versions.sqlite,
    setReturnArrays: returnArrays,
    i1Error: expected,
    workError: expected,
  }));
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
