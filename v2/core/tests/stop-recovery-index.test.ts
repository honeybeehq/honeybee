import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { CoreStore } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

// Literal statement texts, asserted verbatim against store.ts so plan pins
// cannot silently drift from the shipped queries.
const STOP_RECOVERY_SQL = `SELECT 1 FROM commands
       WHERE bee_id = ? AND status IN ('done','running')
         AND verb = 'stop' AND target_generation = ?
         AND json_type(args, '$.thenRevive') = 'true'
       LIMIT 1`;
const PENDING_STOP_SQL = `SELECT 1 FROM commands
       WHERE bee_id = ? AND status IN ('queued','running')
         AND verb = 'stop' AND target_generation = ?
       LIMIT 1`;
const PENDING_REVIVE_SQL = `SELECT 1 FROM commands
       WHERE bee_id = ? AND status IN ('queued','running')
         AND verb IN ('revive','send_wake')
         AND COALESCE(target_generation, 0) >= ?
       LIMIT 1`;

function planDetails(db: DatabaseSync, sql: string): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => {
    const detail = (row as { detail?: unknown }).detail;
    assert.ok(typeof detail === "string");
    return detail;
  });
}

function settle(store: CoreStore, id: number): void {
  const claimed = store.claimNextCommand();
  assert.equal(claimed?.id, id);
  store.completeCommand(id);
}

/** ~1k settled commands: 40 generations × (20 false stops + mixed verbs + a failed true stop), one real true at generation 25. */
function seedProbeHistory(store: CoreStore): { beeId: string; generations: number; trueGeneration: number } {
  const { bee } = makeBee(store, "probe");
  const generations = 40;
  const trueGeneration = 25;
  for (let generation = 1; generation <= generations; generation++) {
    if (generation > 1) assert.equal(store.reviveBee(bee.id).generation, generation);
    for (let i = 0; i < 20; i++) {
      settle(store, store.enqueueCommand("stop", bee.id, { thenRevive: false, i }).id);
    }
    settle(store, store.enqueueCommand("send_wake", bee.id).id); // non-stop, same generation
    settle(store, store.enqueueCommand("archive", bee.id).id); // NULL target_generation, non-stop
    // Adversarial: a FAILED stop carrying thenRevive:true must never count.
    const failed = store.enqueueCommand("stop", bee.id, { thenRevive: true, doomed: true });
    assert.equal(store.claimNextCommand()?.id, failed.id);
    assert.equal(store.reportCommandFailure(failed.id, "node_unreachable").status, "failed");
    if (generation === trueGeneration) {
      settle(store, store.enqueueCommand("stop", bee.id, { thenRevive: true }).id);
    }
    store.updateRuntimeState(bee.id, generation, "stopped", { exitCause: "clean" });
  }
  return { beeId: bee.id, generations, trueGeneration };
}

test("stop-recovery predicate stays exact over same-gen, spread, mixed, strict-boolean, transition, and rollback shapes", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open({ maxAttempts: 1 });
  t.after(() => store.close());
  const probe = seedProbeHistory(store);

  const auditBefore = store.lastAuditSeq();
  for (let generation = 1; generation <= probe.generations; generation++) {
    assert.equal(
      store.hasStopThenReviveRequest(probe.beeId, generation),
      generation === probe.trueGeneration,
      `generation ${generation}: only the true-carrying generation may match`,
    );
  }
  assert.equal(store.hasStopThenReviveRequest(probe.beeId, probe.generations + 1), false, "off-history generation");
  assert.equal(store.hasStopThenReviveRequest("missing", 1), false);
  assert.equal(store.lastAuditSeq(), auditBefore, "predicate probes are read-only");

  // Strict JSON booleans, index-served: only boolean true matches.
  const strict = makeBee(store, "strict").bee;
  for (const cmdArgs of [{}, { thenRevive: null }, { thenRevive: false }, { thenRevive: 1 }, { thenRevive: "true" }]) {
    settle(store, store.enqueueCommand("stop", strict.id, cmdArgs).id);
  }
  assert.equal(store.hasStopThenReviveRequest(strict.id, 1), false, "non-boolean thenRevive values never match");
  // Public transitions: queued → running → failed / done.
  const truthy = store.enqueueCommand("stop", strict.id, { thenRevive: true });
  assert.equal(store.hasStopThenReviveRequest(strict.id, 1), false, "queued does not request revival");
  assert.equal(store.claimNextCommand()?.id, truthy.id);
  assert.equal(store.hasStopThenReviveRequest(strict.id, 1), true, "running requests revival");
  assert.equal(store.reportCommandFailure(truthy.id, "node_unreachable").status, "failed");
  assert.equal(store.hasStopThenReviveRequest(strict.id, 1), false, "failed does not request revival");
  settle(store, store.enqueueCommand("stop", strict.id, { thenRevive: true }).id);
  assert.equal(store.hasStopThenReviveRequest(strict.id, 1), true, "done requests revival");
  assert.equal(store.hasStopThenReviveRequest(strict.id, 2), false, "generation matching is exact");

  // Outer rollback: an uncommitted claimed true-stop must vanish cleanly.
  const roll = makeBee(store, "roll").bee;
  assert.throws(
    () => store.transact(() => {
      const cmd = store.enqueueCommand("stop", roll.id, { thenRevive: true });
      assert.equal(store.claimNextCommand()?.id, cmd.id);
      assert.equal(store.hasStopThenReviveRequest(roll.id, 1), true, "uncommitted running stop visible in-transaction");
      throw new Error("outer rollback");
    }),
    /outer rollback/,
  );
  assert.equal(store.hasStopThenReviveRequest(roll.id, 1), false, "rollback restores the index and the answer");
});

test("index installs on reopen without parsing legacy args; plans pin the probe and steal nothing", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store: CoreStore | null = h.open();
  t.after(() => store?.close());
  const storeSource = readFileSync(fileURLToPath(new URL("../src/store.ts", import.meta.url)), "utf8");
  for (const sql of [STOP_RECOVERY_SQL, PENDING_STOP_SQL, PENDING_REVIVE_SQL]) {
    assert.ok(storeSource.includes(sql), "literal statement drifted from store.ts");
  }
  makeBee(store, "legacy");
  makeBee(store, "nullgen");
  store.close();
  store = null;

  const fixture = new DatabaseSync(h.path);
  let schemaVersionBefore: string;
  try {
    const versionRow = fixture.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: unknown };
    assert.ok(typeof versionRow.value === "string");
    schemaVersionBefore = versionRow.value;
    fixture.exec("DROP INDEX IF EXISTS commands_stop_recovery");
    const insert = fixture.prepare(
      `INSERT INTO commands(verb, bee_id, args, target_generation, status, attempts,
        next_attempt_at, enqueued_at, finished_at, failure_cause, idempotency_key)
       VALUES(?, ?, ?, ?, 'done', 1, 0, 0, 1, NULL, NULL)`,
    );
    // Malformed HISTORICAL args on rows the selected query never picks: the
    // index build must succeed because it never parses args.
    for (let i = 0; i < 3; i++) insert.run("stop", "legacy", "not json {{{", 7);
    // Valid-JSON true stop with NULL generation: excluded by `=` for every generation.
    insert.run("stop", "nullgen", JSON.stringify({ thenRevive: true }), null);
    // Control BEFORE the index exists: the original residual behavior throws
    // on the malformed row's own bucket and answers false elsewhere.
    const raw = fixture.prepare(STOP_RECOVERY_SQL);
    assert.equal(raw.get("legacy", 8), undefined, "pre-index: empty bucket answers false");
    assert.throws(() => raw.get("legacy", 7), /malformed JSON|JSON/, "pre-index: residual json_type raises on the malformed bucket");
  } finally {
    fixture.close();
  }

  store = h.open(); // SCHEMA_SQL reinstalls the index over the malformed rows: must not throw
  store.close(); // EXCLUSIVE locking: release before the read-only inspection connection
  store = null;
  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    const indexSql = check.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'commands_stop_recovery'",
    ).get() as { sql?: unknown };
    assert.ok(typeof indexSql.sql === "string", "index reinstalled on reopen");
    assert.match(indexSql.sql, /WHERE verb = 'stop' AND status IN \('done','running'\)/);
    assert.doesNotMatch(indexSql.sql, /json/i, "no JSON expression in the index");
    const versionRow = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: unknown };
    assert.equal(versionRow.value, schemaVersionBefore, "additive index does not change the schema format");

    const probePlan = planDetails(check, STOP_RECOVERY_SQL).join("\n");
    assert.match(probePlan, /USING INDEX commands_stop_recovery \(bee_id=\? AND target_generation=\?\)/);
    assert.doesNotMatch(probePlan, /USE TEMP B-TREE/);
    for (const [name, sql, expected] of [
      ["pending-stop", PENDING_STOP_SQL, /USING INDEX commands_by_bee_status/],
      ["pending-revive", PENDING_REVIVE_SQL, /USING INDEX commands_by_bee_status/],
      ["claim", "SELECT * FROM commands WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT 1", /USING INDEX commands_ready/],
      ["list", "SELECT * FROM commands WHERE bee_id = ? ORDER BY id", /USING INDEX commands_by_bee/],
    ] as const) {
      const plan = planDetails(check, sql).join("\n");
      assert.match(plan, expected, `${name} keeps its original index`);
      assert.doesNotMatch(plan, /commands_stop_recovery/, `${name} must not adopt the stop-recovery index`);
    }
  } finally {
    check.close();
  }

  // Selected query behavior remains ORIGINAL with the index in place
  // (this reopen also proves the IF NOT EXISTS install is idempotent).
  store = h.open();
  assert.equal(store.hasStopThenReviveRequest("legacy", 8), false, "empty bucket answers false without touching malformed rows");
  assert.throws(() => store!.hasStopThenReviveRequest("legacy", 7), /malformed JSON|JSON/,
    "the residual json_type still raises on the malformed bucket, exactly as before the index");
  assert.equal(store.hasStopThenReviveRequest("nullgen", 1), false, "NULL target_generation rows are excluded by =");
  assert.equal(store.hasStopThenReviveRequest("nullgen", 0), false);
});
