import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness, makeBee } from "./helpers.ts";

function indexColumns(db: DatabaseSync, name: string): string[] {
  return (db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name) as Array<{ name: string }>)
    .map((row) => row.name);
}

function planDetails(db: DatabaseSync, sql: string, ...params: string[]): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail);
}

test("command bee indexes install on populated reopen and preserve ordered API reads", () => {
  const h = harness();
  let store = h.open({ maxAttempts: 1 });
  try {
    const { bee } = makeBee(store, "target");
    const { bee: otherBee } = makeBee(store, "other");

    const done = store.enqueueCommand("archive", bee.id);
    assert.equal(store.claimNextCommand()?.id, done.id);
    store.completeCommand(done.id);

    const otherDone = store.enqueueCommand("archive", otherBee.id);
    assert.equal(store.claimNextCommand()?.id, otherDone.id);
    store.completeCommand(otherDone.id);

    const failed = store.enqueueCommand("archive", bee.id);
    assert.equal(store.claimNextCommand()?.id, failed.id);
    store.reportCommandFailure(failed.id, "node_unreachable");

    const queuedOne = store.enqueueCommand("archive", bee.id);
    store.enqueueCommand("archive", otherBee.id);
    const queuedTwo = store.enqueueCommand("archive", bee.id);

    store.close();
    const beforeReopen = new DatabaseSync(h.path);
    let schemaVersionBefore: string;
    try {
      schemaVersionBefore = String(
        (beforeReopen.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      );
      beforeReopen.exec("DROP INDEX IF EXISTS commands_by_bee");
      beforeReopen.exec("DROP INDEX IF EXISTS commands_by_bee_status");
    } finally {
      beforeReopen.close();
    }

    store = h.open({ maxAttempts: 1 });
    const stateBeforeReads = store.dumpState();
    const auditBeforeReads = store.lastAuditSeq();
    assert.deepEqual(
      store.listCommands({ beeId: bee.id }).map((command) => [command.id, command.status]),
      [
        [done.id, "done"],
        [failed.id, "failed"],
        [queuedOne.id, "queued"],
        [queuedTwo.id, "queued"],
      ],
    );
    assert.deepEqual(
      store.listCommands({ beeId: bee.id, status: "queued" }).map((command) => command.id),
      [queuedOne.id, queuedTwo.id],
    );
    assert.deepEqual(
      store.listCommands({ beeId: bee.id, status: "failed" }).map((command) => command.id),
      [failed.id],
    );
    assert.deepEqual(store.listCommands({ beeId: "missing" }), []);
    assert.equal(store.lastAuditSeq(), auditBeforeReads, "command history reads do not append authority events");
    assert.deepEqual(store.dumpState(), stateBeforeReads, "command history reads do not mutate authority state");

    assert.equal(store.claimNextCommand()?.id, queuedOne.id);
    const deleted = store.deleteBee(bee.id);
    assert.deepEqual(deleted.settledCommandIds, [queuedOne.id, queuedTwo.id]);
    assert.equal(store.getCommand(done.id)?.status, "done");
    assert.equal(store.getCommand(failed.id)?.status, "failed");
    assert.equal(store.getCommand(queuedOne.id)?.status, "done");
    assert.equal(store.getCommand(queuedTwo.id)?.status, "done");
    assert.equal(store.listCommands({ beeId: otherBee.id, status: "queued" }).length, 1);
    store.close();

    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      assert.deepEqual(indexColumns(check, "commands_ready"), ["status", "next_attempt_at", "id"]);
      assert.deepEqual(indexColumns(check, "commands_by_bee"), ["bee_id", "id"]);
      assert.deepEqual(indexColumns(check, "commands_by_bee_status"), ["bee_id", "status", "id"]);

      const historyPlan = planDetails(
        check,
        "SELECT * FROM commands WHERE bee_id = ? ORDER BY id",
        bee.id,
      );
      assert.match(historyPlan.join("\n"), /USING INDEX commands_by_bee \(bee_id=\?\)/);
      assert.doesNotMatch(historyPlan.join("\n"), /USE TEMP B-TREE/);

      const statusPlan = planDetails(
        check,
        "SELECT * FROM commands WHERE bee_id = ? AND status = ? ORDER BY id",
        bee.id,
        "queued",
      );
      assert.match(statusPlan.join("\n"), /USING INDEX commands_by_bee_status \(bee_id=\? AND status=\?\)/);
      assert.doesNotMatch(statusPlan.join("\n"), /USE TEMP B-TREE/);

      const deletePendingPlan = planDetails(
        check,
        `SELECT id FROM commands INDEXED BY commands_by_bee_status
         WHERE bee_id = ? AND status IN ('queued','running') ORDER BY id`,
        otherBee.id,
      );
      assert.match(
        deletePendingPlan.join("\n"),
        /USING COVERING INDEX commands_by_bee_status \(bee_id=\? AND status=\?\)/,
      );

      const schemaVersionAfter = String(
        (check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      );
      assert.equal(schemaVersionAfter, schemaVersionBefore, "adding indexes does not change the schema format");
    } finally {
      check.close();
    }
  } finally {
    store.close();
    h.cleanup();
  }
});
