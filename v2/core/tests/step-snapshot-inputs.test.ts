import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness, makeBee } from "./helpers.ts";

function stringField(row: unknown, field: "detail" | "name" | "sql" | "value"): string {
  if (row === null || typeof row !== "object") throw new Error(`missing SQLite ${field} field`);
  switch (field) {
    case "detail":
      if (!("detail" in row) || typeof row.detail !== "string") throw new Error("SQLite detail field is not text");
      return row.detail;
    case "name":
      if (!("name" in row) || typeof row.name !== "string") throw new Error("SQLite name field is not text");
      return row.name;
    case "sql":
      if (!("sql" in row) || typeof row.sql !== "string") throw new Error("SQLite sql field is not text");
      return row.sql;
    case "value":
      if (!("value" in row) || typeof row.value !== "string") throw new Error("SQLite value field is not text");
      return row.value;
    default: {
      const exhaustive: never = field;
      throw new Error(`unknown SQLite field: ${exhaustive}`);
    }
  }
}

function indexColumns(db: DatabaseSync, name: string): string[] {
  return db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name)
    .map((row) => stringField(row, "name"));
}

function planDetails(db: DatabaseSync, sql: string): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
    .map((row) => stringField(row, "detail"));
}

test("step snapshot inputs prove empty across stopped history and detect every live runtime state", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  assert.equal(store.hasStepSnapshotInputs(), false, "an empty store has no step input");

  const { bee, runtime } = makeBee(store, "state-probe");
  store.archiveBee(bee.id);
  assert.equal(store.currentRuntime(bee.id)?.state, "booting");
  assert.equal(store.hasStepSnapshotInputs(), true, "an archived booting runtime remains live input");

  store.unarchiveBee(bee.id);
  store.updateRuntimeState(bee.id, runtime.generation, "running", { pid: 101, pidStartedAt: 10 });
  assert.equal(store.hasStepSnapshotInputs(), true, "running is live input");
  store.updateRuntimeState(bee.id, runtime.generation, "idle");
  assert.equal(store.hasStepSnapshotInputs(), true, "idle is live input");
  store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
  assert.equal(store.hasStepSnapshotInputs(), false, "stopped is not step input without mail");

  store.setFlag(bee.id, "auth_needed", "test flag");
  store.setBeeTitle(bee.id, "retained metadata");
  store.tagBee(bee.id, { add: ["history"] });
  assert.equal(store.hasStepSnapshotInputs(), false, "flags and retained bee metadata do not need a snapshot");

  for (let generation = 2; generation <= 21; generation++) {
    const revived = store.reviveBee(bee.id);
    assert.equal(revived.generation, generation);
    assert.equal(store.hasStepSnapshotInputs(), true, `booting generation ${generation} is visible`);
    store.updateRuntimeState(bee.id, generation, "stopped", { exitCause: "clean" });
    assert.equal(store.hasStepSnapshotInputs(), false, `stopped history through generation ${generation} proves empty`);
  }

  const auditBeforeRead = store.lastAuditSeq();
  assert.equal(store.hasStepSnapshotInputs(), false);
  assert.equal(store.lastAuditSeq(), auditBeforeRead, "existence probes are read-only");
});

test("step snapshot inputs detect pending mail for stopped and absent runtimes", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const { bee, runtime } = makeBee(store, "mail-probe");
  store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
  assert.equal(store.hasStepSnapshotInputs(), false);

  const stoppedMail = store.send(bee.id, "pending while stopped");
  assert.ok(stoppedMail.wakeCommand);
  assert.equal(store.hasStepSnapshotInputs(), true, "mail is input even when the current runtime is stopped");
  assert.deepEqual(store.cancelMessage(bee.id, stoppedMail.message.id), { canceled: true });
  assert.equal(store.hasStepSnapshotInputs(), false, "queued wake commands are outside the snapshot predicate");

  store.close();
  const fixture = new DatabaseSync(h.path);
  try {
    fixture.prepare("DELETE FROM runtimes WHERE bee_id = ?").run(bee.id);
  } finally {
    fixture.close();
  }

  store = h.open();
  assert.equal(store.currentRuntime(bee.id), null);
  assert.equal(store.hasStepSnapshotInputs(), false, "a bee with no runtime and no mail proves empty");
  const absentRuntimeMail = store.send(bee.id, "pending without a runtime");
  assert.ok(absentRuntimeMail.wakeCommand);
  assert.equal(store.currentRuntime(bee.id), null);
  assert.equal(store.hasStepSnapshotInputs(), true, "mail remains input when no runtime row exists");
});

test("an old noncurrent live runtime is a conservative step snapshot false positive", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const { bee, runtime } = makeBee(store, "old-live");
  store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
  const current = store.reviveBee(bee.id);
  store.updateRuntimeState(bee.id, current.generation, "stopped", { exitCause: "clean" });
  store.close();

  const fixture = new DatabaseSync(h.path);
  try {
    fixture.prepare(
      "UPDATE runtimes SET state = 'booting', exit_cause = NULL WHERE bee_id = ? AND generation = ?",
    ).run(bee.id, runtime.generation);
  } finally {
    fixture.close();
  }

  store = h.open();
  assert.equal(store.currentRuntime(bee.id)?.generation, current.generation);
  assert.equal(store.currentRuntime(bee.id)?.state, "stopped");
  assert.deepEqual(store.listUndeliveredMessages(), []);
  assert.equal(
    store.hasStepSnapshotInputs(),
    true,
    "the any-generation probe may run the old fallback but must never miss current work",
  );
});

test("step snapshot input indexes install on populated reopen and back both absence probes", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const { bee, runtime } = makeBee(store, "index-probe");
  const delivered = store.send(bee.id, "delivered history only").message;
  assert.deepEqual(store.markDelivered(delivered.id, runtime.generation), { applied: true });
  store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
  for (let generation = 2; generation <= 20; generation++) {
    store.reviveBee(bee.id);
    store.updateRuntimeState(bee.id, generation, "stopped", { exitCause: "clean" });
  }
  assert.equal(store.hasStepSnapshotInputs(), false);
  store.close();

  const beforeReopen = new DatabaseSync(h.path);
  let schemaVersionBefore: string;
  try {
    schemaVersionBefore = stringField(
      beforeReopen.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(),
      "value",
    );
    beforeReopen.exec("DROP INDEX IF EXISTS runtimes_daemon_live");
    beforeReopen.exec("DROP INDEX IF EXISTS mailbox_undelivered");
  } finally {
    beforeReopen.close();
  }

  store = h.open();
  assert.equal(store.hasStepSnapshotInputs(), false, "delivered-only mail and stopped history stay empty");
  store.close();

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    assert.deepEqual(indexColumns(check, "runtimes_daemon_live"), ["bee_id", "generation"]);
    assert.deepEqual(indexColumns(check, "mailbox_undelivered"), ["bee_id", "id"]);
    assert.match(
      stringField(
        check.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'runtimes_daemon_live'").get(),
        "sql",
      ),
      /WHERE state != 'stopped'/,
    );

    const runtimePlan = planDetails(
      check,
      "SELECT 1 FROM runtimes WHERE state != 'stopped' LIMIT 1",
    ).join("\n");
    assert.match(runtimePlan, /USING (?:COVERING )?INDEX runtimes_daemon_live/);

    const mailboxPlan = planDetails(
      check,
      "SELECT 1 FROM mailbox WHERE delivered_at IS NULL LIMIT 1",
    ).join("\n");
    assert.match(mailboxPlan, /USING (?:COVERING )?INDEX mailbox_undelivered/);

    const schemaVersionAfter = stringField(
      check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(),
      "value",
    );
    assert.equal(schemaVersionAfter, schemaVersionBefore, "additive indexes do not change the schema format");
  } finally {
    check.close();
  }
});
