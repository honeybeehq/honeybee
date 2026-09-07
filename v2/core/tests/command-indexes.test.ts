import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { CoreStore } from "../src/index.ts";
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

      for (const [predicateSql, expectedIndex] of [
        // The stop-recovery predicate seeks its dedicated partial index; the
        // pending predicates cannot (their queued status falls outside its
        // WHERE) and keep the settled-history bucket index.
        [
          `SELECT 1 FROM commands
         WHERE bee_id = ? AND status IN ('done','running') AND verb = 'stop'
           AND target_generation = 1 AND json_type(args, '$.thenRevive') = 'true' LIMIT 1`,
          /USING INDEX commands_stop_recovery \(bee_id=\? AND target_generation=\?\)/,
        ],
        [
          `SELECT 1 FROM commands
         WHERE bee_id = ? AND status IN ('queued','running') AND verb IN ('revive','send_wake')
           AND COALESCE(target_generation, 0) >= 1 LIMIT 1`,
          /USING INDEX commands_by_bee_status \(bee_id=\? AND status=\?\)/,
        ],
        [
          `SELECT 1 FROM commands
         WHERE bee_id = ? AND status IN ('queued','running') AND verb = 'stop'
           AND target_generation = 1 LIMIT 1`,
          /USING INDEX commands_by_bee_status \(bee_id=\? AND status=\?\)/,
        ],
      ] as const) {
        const predicatePlan = planDetails(check, predicateSql, bee.id).join("\n");
        assert.match(predicatePlan, expectedIndex);
        assert.doesNotMatch(predicatePlan, /USE TEMP B-TREE/);
      }

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

test("command stop-revive predicate requires a strict true value and exact status and generation", () => {
  const h = harness();
  const store = h.open({ maxAttempts: 1 });
  try {
    const { bee } = makeBee(store, "stop-revive-probe");
    for (const args of [
      {},
      { thenRevive: null },
      { thenRevive: false },
      { thenRevive: 1 },
      { thenRevive: "true" },
    ]) {
      const command = store.enqueueCommand("stop", bee.id, args);
      assert.equal(store.claimNextCommand()?.id, command.id);
      store.completeCommand(command.id);
    }
    const otherVerb = store.enqueueCommand("archive", bee.id, { thenRevive: true });
    assert.equal(store.claimNextCommand()?.id, otherVerb.id);
    store.completeCommand(otherVerb.id);

    assert.equal(store.hasStopThenReviveRequest(bee.id, 1), false);

    const failed = store.enqueueCommand("stop", bee.id, { thenRevive: true });
    assert.equal(store.hasStopThenReviveRequest(bee.id, 1), false, "queued does not request revival");
    assert.equal(store.claimNextCommand()?.id, failed.id);
    assert.equal(store.hasStopThenReviveRequest(bee.id, 1), true, "running requests revival");
    assert.equal(store.reportCommandFailure(failed.id, "node_unreachable").status, "failed");
    assert.equal(store.hasStopThenReviveRequest(bee.id, 1), false, "failed does not request revival");

    const done = store.enqueueCommand("stop", bee.id, { thenRevive: true });
    assert.equal(store.claimNextCommand()?.id, done.id);
    store.completeCommand(done.id);
    assert.equal(store.hasStopThenReviveRequest(bee.id, 1), true, "done requests revival");
    assert.equal(store.hasStopThenReviveRequest(bee.id, 2), false, "generation matching is exact");
    assert.equal(store.hasStopThenReviveRequest("missing", 1), false);

    const historyBefore = store.listCommands({ beeId: bee.id });
    const stateBefore = store.dumpState();
    const auditBefore = store.lastAuditSeq();
    assert.equal(store.hasStopThenReviveRequest(bee.id, 1), true);
    assert.equal(store.hasStopThenReviveRequest(bee.id, 2), false);
    assert.equal(store.lastAuditSeq(), auditBefore, "the stop-revive predicate is read-only");
    assert.deepEqual(store.dumpState(), stateBefore);
    assert.deepEqual(store.listCommands({ beeId: bee.id }), historyBefore, "complete ordered history is unchanged");
  } finally {
    store.close();
    h.cleanup();
  }
});

test("command pending predicates preserve statuses, generation rules, null fallback, and future intent", () => {
  const h = harness();
  let store: CoreStore | null = h.open({ maxAttempts: 3, backoffBaseMs: 10_000 });
  try {
    for (const beeId of ["negative", "equal-revive", "above-wake", "null-wake", "stop-match", "running"]) {
      store.createBee({ id: beeId, name: beeId, agent: "stub", substrate: "hsr", cwd: "/tmp" });
    }
    store.close();
    store = null;

    const future = 9_000_000_000;
    const fixture = new DatabaseSync(h.path);
    try {
      const insert = fixture.prepare(
        `INSERT INTO commands(
           verb, bee_id, args, target_generation, status, attempts,
           next_attempt_at, enqueued_at, finished_at, failure_cause, idempotency_key
         ) VALUES(?, ?, '{}', ?, ?, 0, ?, 1, ?, NULL, NULL)`,
      );
      for (const row of [
        { beeId: "negative", verb: "revive", status: "done", target: 10 },
        { beeId: "negative", verb: "send_wake", status: "failed", target: 10 },
        { beeId: "negative", verb: "revive", status: "queued", target: 9 },
        { beeId: "negative", verb: "archive", status: "queued", target: 11 },
        { beeId: "negative", verb: "stop", status: "queued", target: 9 },
        { beeId: "negative", verb: "stop", status: "done", target: 10 },
        { beeId: "negative", verb: "stop", status: "failed", target: 10 },
        { beeId: "equal-revive", verb: "revive", status: "queued", target: 10 },
        { beeId: "above-wake", verb: "send_wake", status: "queued", target: 11 },
        { beeId: "null-wake", verb: "send_wake", status: "queued", target: null },
        { beeId: "stop-match", verb: "stop", status: "queued", target: 7 },
      ]) {
        insert.run(
          row.verb,
          row.beeId,
          row.target,
          row.status,
          future,
          row.status === "queued" ? null : 2,
        );
      }
    } finally {
      fixture.close();
    }

    store = h.open({ maxAttempts: 3, backoffBaseMs: 10_000 });
    assert.equal(store.hasPendingReviveOrWakeCommand("negative", 10), false);
    assert.equal(store.hasPendingStopCommand("negative", 10), false);
    assert.equal(store.hasPendingReviveOrWakeCommand("equal-revive", 10), true, "future equal revive is pending");
    assert.equal(store.hasPendingReviveOrWakeCommand("equal-revive", 11), false);
    assert.equal(store.hasPendingReviveOrWakeCommand("above-wake", 10), true, "future later wake is pending");
    assert.equal(store.hasPendingReviveOrWakeCommand("null-wake", 0), true, "null falls back to generation zero");
    assert.equal(store.hasPendingReviveOrWakeCommand("null-wake", 1), false);
    assert.equal(store.hasPendingStopCommand("stop-match", 7), true, "future exact stop is pending");
    assert.equal(store.hasPendingStopCommand("stop-match", 8), false);

    const runningRevive = store.enqueueCommand("revive", "running");
    assert.equal(store.hasPendingReviveOrWakeCommand("running", 1), true, "queued revive is pending");
    assert.equal(store.claimNextCommand()?.id, runningRevive.id);
    assert.equal(store.hasPendingReviveOrWakeCommand("running", 1), true, "running revive is pending");
    store.completeCommand(runningRevive.id);
    assert.equal(store.hasPendingReviveOrWakeCommand("running", 1), false, "done revive is not pending");

    const runningStop = store.enqueueCommand("stop", "running");
    assert.equal(store.hasPendingStopCommand("running", 1), true, "queued stop is pending");
    assert.equal(store.claimNextCommand()?.id, runningStop.id);
    assert.equal(store.hasPendingStopCommand("running", 1), true, "running stop is pending");
    store.completeCommand(runningStop.id);
    assert.equal(store.hasPendingStopCommand("running", 1), false, "done stop is not pending");

    const historyBefore = store.listCommands({ beeId: "negative" });
    assert.deepEqual(
      historyBefore.map((command) => command.id),
      [...historyBefore.map((command) => command.id)].sort((a, b) => a - b),
    );
    const stateBefore = store.dumpState();
    const auditBefore = store.lastAuditSeq();
    assert.equal(store.hasPendingReviveOrWakeCommand("equal-revive", 10), true);
    assert.equal(store.hasPendingReviveOrWakeCommand("null-wake", 1), false);
    assert.equal(store.hasPendingStopCommand("stop-match", 7), true);
    assert.equal(store.hasPendingStopCommand("missing", 1), false);
    assert.equal(store.lastAuditSeq(), auditBefore, "pending command predicates are read-only");
    assert.deepEqual(store.dumpState(), stateBefore);
    assert.deepEqual(
      store.listCommands({ beeId: "negative" }),
      historyBefore,
      "complete ordered history is unchanged",
    );
  } finally {
    store?.close();
    h.cleanup();
  }
});
