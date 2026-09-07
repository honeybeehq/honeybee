import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = process.argv[2];
assert.ok(root, "usage: node proof.mjs ROOT");
const local = async (relative) => import(pathToFileURL(join(root, relative)).href);
const { openCoreStore } = await local("v2/core/src/index.ts");
const { captureSql } = await local("scripts/perf/sql-trace.mjs");

const probe = new DatabaseSync(":memory:");
const returnArrays = typeof probe.prepare("SELECT 1").setReturnArrays;
probe.close();

const dir = mkdtempSync(join(tmpdir(), "hb-i1-trace-"));
const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
try {
  const created = store.createBee({
    id: "trace-bee-uuid-sized-0000000000000000",
    name: "trace",
    agent: "stub",
    substrate: "hsr",
    cwd: "/tmp",
  });
  store.updateRuntimeState(created.bee.id, created.runtime.generation, "running", { synthetic: true });
  const first = store.send(created.bee.id, "body-not-projected", { urgency: "idle" }).message;
  const second = store.send(created.bee.id, "other-body-not-projected", { urgency: "now" }).message;

  const captured = captureSql(() => store.readDaemonStepInputs());
  const sql = `SELECT id, bee_id, urgency, enqueued_at
       FROM mailbox
       WHERE delivered_at IS NULL
       ORDER BY bee_id, id`;
  const messageRead = captured.statements.find((row) => row.kind === "all" && row.sql === sql);
  assert.ok(messageRead);
  assert.equal(messageRead.rows, 2);
  assert.equal(
    messageRead.textBytes,
    2 * Buffer.byteLength(created.bee.id) + Buffer.byteLength("idle") + Buffer.byteLength("now"),
  );
  assert.equal(messageRead.blobBytes, 0);
  assert.deepEqual(captured.value.i1[0].pending, [
    { id: first.id, urgency: "idle", enqueuedAt: first.enqueuedAt },
    { id: second.id, urgency: "now", enqueuedAt: second.enqueuedAt },
  ]);
  assert.strictEqual(captured.value.work[0].pending, captured.value.i1[0].pending);
  assert.strictEqual(captured.value.work[0].pending[0], captured.value.i1[0].pending[0]);

  console.log(JSON.stringify({
    node: process.version,
    sqlite: process.versions.sqlite,
    setReturnArrays: returnArrays,
    rows: messageRead.rows,
    textBytes: messageRead.textBytes,
    blobBytes: messageRead.blobBytes,
    sharedArray: true,
    sharedMessage: true,
  }));
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
