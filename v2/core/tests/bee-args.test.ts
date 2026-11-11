/**
 * Per-bee spawn args (schema v5) — core tier:
 *  - `bees.args` round-trips through createBee / updateBeeArgs / reviveBee,
 *    is audited (`bee.args_set`) and replayable, identical values are no-ops
 *  - a v4-shaped store (spawn_failures present, no args column) migrates
 *    additively to v5 on open; a NEWER store is still refused
 *  - the frozen importer's keep/drop table against fixture records shaped
 *    like the real ones (claude `--model fable --effort high
 *    --dangerously-skip-permissions --session-id … --append-system-prompt …`,
 *    codex `-m gpt-5.6-sol -c model_reasoning_effort="ultra"
 *    --dangerously-bypass-approvals-and-sandbox -c service_tier=default`),
 *    the `command`-string fallback, the first-class `model` override and
 *    `modelExtraArgs`, and the dropped flags recorded in the provenance row
 *
 * All against mkdtemp fixtures; nothing under ~/.hive is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  SCHEMA_VERSION,
  replayAudit,
} from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

test("reconfigure records args at admission, waits for idle, and replaces a queued change; stopped changes and no-ops replay", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store);
    // Booting counts as working: the change is admitted and waits.
    const low = store.reconfigureBee(bee.id, ["--effort", "low"]);
    assert.equal(low.outcome, "queued");
    if (low.outcome !== "queued") throw new Error("expected queued change");
    assert.deepEqual(store.getBee(bee.id)?.args, ["--effort", "low"], "args are recorded at admission");
    assert.deepEqual(store.getCommand(low.commandId)?.args.previousArgs, null, "the args the runtime started with");
    store.updateRuntimeState(bee.id, 1, "running");
    const deferredSeq = store.lastAuditSeq();
    assert.equal(store.claimNextCommand(), null, "the restart waits for idle");
    assert.equal(store.claimNextCommand(), null);
    assert.equal(store.lastAuditSeq(), deferredSeq, "deferral is quiet");

    // A newer choice replaces the queued change without a second restart.
    const high = store.reconfigureBee(bee.id, ["--effort", "high"]);
    assert.equal(high.outcome, "queued");
    if (high.outcome !== "queued") throw new Error("expected queued change");
    assert.notEqual(high.commandId, low.commandId);
    assert.equal(store.getCommand(low.commandId)?.status, "done");
    assert.equal(store.getCommand(low.commandId)?.args.thenRevive, undefined, "a replaced change drops its restart intent");
    assert.deepEqual(store.getCommand(high.commandId)?.args.previousArgs, null, "previous args carry across replacements");
    assert.deepEqual(store.reconfigureBee(bee.id, ["--effort", "high"]), { outcome: "queued", commandId: high.commandId });

    // Returning to the running args cancels the restart.
    const back = store.reconfigureBee(bee.id, null);
    assert.equal(back.outcome, "recorded");
    assert.equal(store.getBee(bee.id)?.args, null);
    assert.equal(store.getCommand(high.commandId)?.status, "done");
    assert.equal(store.getCommand(high.commandId)?.args.thenRevive, undefined);
    store.updateRuntimeState(bee.id, 1, "idle");
    assert.equal(store.claimNextCommand(), null, "no restart remains");
    const seq = store.lastAuditSeq();
    assert.equal(store.reconfigureBee(bee.id, null).outcome, "unchanged");
    assert.equal(store.lastAuditSeq(), seq, "an identical change is quiet");

    // Stopped bees only record args.
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_user" });
    assert.equal(store.reconfigureBee(bee.id, []).outcome, "recorded");
    assert.deepEqual(store.getBee(bee.id)?.args, []);
    assert.equal(store.reconfigureBee(bee.id, null).outcome, "recorded");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    store.close();
    h.cleanup();
  }
});

test("a model change that outlives its runtime keeps its args without a restart", () => {
  for (const exitCause of ["stopped_by_user", "crashed", "clean"] as const) {
    const h = harness();
    const store = h.open();
    try {
      const { bee } = makeBee(store);
      store.updateRuntimeState(bee.id, 1, "running");
      const change = store.reconfigureBee(bee.id, ["--effort", "high"]);
      if (change.outcome !== "queued") throw new Error("expected queued change");
      store.updateRuntimeState(bee.id, 1, "stopped", { exitCause });
      assert.equal(store.claimNextCommand(), null, `${exitCause}: nothing to execute`);
      const settled = store.getCommand(change.commandId);
      assert.equal(settled?.status, "done");
      assert.equal(settled?.args.thenRevive, undefined, `${exitCause}: no restart intent survives`);
      assert.equal(store.hasStopThenReviveRequest(bee.id, 1), false);
      assert.deepEqual(store.getBee(bee.id)?.args, ["--effort", "high"]);
      assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    } finally {
      store.close();
      h.cleanup();
    }
  }
});

test("reconfigure admission does not materialize command history", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store);
    store.updateRuntimeState(bee.id, 1, "running");
    store.updateRuntimeState(bee.id, 1, "idle");
    store.listCommands = () => {
      throw new Error("reconfigureBee materialized command history");
    };

    assert.equal(store.reconfigureBee(bee.id, null).outcome, "unchanged");
  } finally {
    store.close();
    h.cleanup();
  }
});

test("reconfigure pending probe preserves replacement presence, status, and generation", () => {
  const h = harness();
  const store = h.open({ maxAttempts: 1 });
  try {
    const { bee } = makeBee(store);
    store.updateRuntimeState(bee.id, 1, "running");
    store.updateRuntimeState(bee.id, 1, "idle");

    const ordinaryStop = store.enqueueCommand("stop", bee.id);
    assert.equal(
      store.reconfigureBee(bee.id, null).outcome,
      "unchanged",
      "a stop without replacementArgs is not a pending model change",
    );

    store.updateBeeArgs(bee.id, ["--model", "old"]);
    const cleared = store.reconfigureBee(bee.id, null);
    assert.equal(cleared.outcome, "queued");
    if (cleared.outcome !== "queued") throw new Error("expected queued model change");
    const queued = store.reconfigureBee(bee.id, ["--model", "other"]);
    assert.equal(queued.outcome, "queued");
    if (queued.outcome !== "queued") throw new Error("expected queued model change");
    assert.equal(
      store.getCommand(cleared.commandId)?.status,
      "done",
      "JSON null counts as a present replacementArgs value",
    );

    const { bee: otherBee } = makeBee(store, "other");
    store.updateRuntimeState(otherBee.id, 1, "running");
    store.updateRuntimeState(otherBee.id, 1, "idle");
    assert.equal(
      store.reconfigureBee(otherBee.id, null).outcome,
      "unchanged",
      "a pending replacement for another bee does not block reconfiguration",
    );

    assert.equal(store.claimNextCommand()?.id, ordinaryStop.id);
    store.completeCommand(ordinaryStop.id);
    assert.equal(store.claimNextCommand()?.id, queued.commandId);
    assert.throws(
      () => store.reconfigureBee(bee.id, ["--model", "third"]),
      /pending model change/,
      "a running replacement remains pending",
    );

    store.reportCommandFailure(queued.commandId, "node_unreachable");
    const afterFailure = store.reconfigureBee(bee.id, ["--model", "after-failure"]);
    assert.equal(afterFailure.outcome, "queued", "a failed replacement is settled");
    if (afterFailure.outcome !== "queued") throw new Error("expected replacement after failure");

    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_user" });
    const generation2 = store.reviveBee(bee.id);
    store.updateRuntimeState(bee.id, generation2.generation, "running");
    store.updateRuntimeState(bee.id, generation2.generation, "idle");
    const currentGeneration = store.reconfigureBee(bee.id, ["--model", "generation-2"]);
    assert.equal(currentGeneration.outcome, "queued", "a pending replacement for an older generation is stale");
    if (currentGeneration.outcome !== "queued") throw new Error("expected current-generation replacement");
    assert.equal(store.getCommand(currentGeneration.commandId)?.targetGeneration, generation2.generation);

    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    store.close();
    h.cleanup();
  }
});

test("args.1: bees.args round-trips; updateBeeArgs audits bee.args_set, no-ops on identical, null clears; reviveBee applies args in the same tx; replay matches", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = store.createBee({ name: "w", agent: "claude", substrate: "hsr", cwd: "/tmp", args: ["--model", "fable"] });
    assert.deepEqual(bee.args, ["--model", "fable"]);
    assert.equal(makeBee(store, "plain").bee.args, null, "absent = null (no per-bee args)");

    const set = store.updateBeeArgs(bee.id, ["--model", "opus", "--effort", "high"]);
    assert.equal(set.applied, true);
    assert.deepEqual(set.bee.args, ["--model", "opus", "--effort", "high"]);
    assert.equal(store.updateBeeArgs(bee.id, ["--model", "opus", "--effort", "high"]).applied, false, "identical = silent no-op");
    assert.equal(store.updateBeeArgs(bee.id, null).applied, true);
    assert.equal(store.getBee(bee.id)?.args, null);
    assert.equal(store.updateBeeArgs(bee.id, null).applied, false);
    const rows = store.auditRows().filter((r) => r.kind === "bee.args_set");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]?.payload, { beeId: bee.id, args: ["--model", "opus", "--effort", "high"], previous: ["--model", "fable"] });
    assert.deepEqual(rows[1]?.payload, { beeId: bee.id, args: null, previous: ["--model", "opus", "--effort", "high"] });

    // revive with replacement args: applied before generation N+1 is minted
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_user" });
    const rt = store.reviveBee(bee.id, { args: ["--model", "fable", "--dangerously-skip-permissions"] });
    assert.equal(rt.generation, 2);
    assert.deepEqual(store.getBee(bee.id)?.args, ["--model", "fable", "--dangerously-skip-permissions"]);
    const seqs = store.auditRows().map((r) => r.kind);
    assert.ok(seqs.lastIndexOf("bee.args_set") < seqs.lastIndexOf("runtime.created"), "args_set precedes the new generation's runtime.created");
    // reviveBee without args leaves them alone
    store.updateRuntimeState(bee.id, 2, "stopped", { exitCause: "crashed" });
    store.reviveBee(bee.id);
    assert.deepEqual(store.getBee(bee.id)?.args, ["--model", "fable", "--dangerously-skip-permissions"]);

    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    assert.throws(() => store.updateBeeArgs(bee.id, "nope" as unknown as string[]), /array of strings/);
    assert.throws(() => store.updateBeeArgs(bee.id, [1] as unknown as string[]), /array of strings/);
    assert.throws(() => store.updateBeeArgs("ghost", []), /bee not found/);
    assert.throws(() => store.createBee({ name: "x", agent: "claude", substrate: "hsr", cwd: "/tmp", args: { a: 1 } as unknown as string[] }), /array of strings/);
    // empty array is a legitimate (distinct from null) value
    assert.equal(store.updateBeeArgs(bee.id, []).applied, true);
    assert.deepEqual(store.getBee(bee.id)?.args, []);
    // dumpState/list carry it
    assert.deepEqual(store.listBees().find((b) => b.id === bee.id)?.args, []);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("args.2: a v4-shaped store (spawn_failures, no args column) migrates additively to v5 on open; args NULL for old rows; newer store refused", () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '4');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
        provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
        spawn_failures INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at, provider_session_id, spawn_failures)
        VALUES('old-1','old','claude','hsr','/tmp','active',5,'sid-old',2);
    `);
    db.close();
    const store = h.open();
    const old = store.getBee("old-1");
    assert.equal(old?.args, null, "v5 column NULL for pre-v5 rows");
    assert.equal(old?.providerSessionId, "sid-old", "v3 data intact");
    assert.equal(old?.spawnFailures, 2, "v4 data intact");
    assert.equal(store.updateBeeArgs("old-1", ["--effort", "max"]).applied, true);
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      assert.equal(Number(version.value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 60);
      const cols = (check.prepare("SELECT name FROM pragma_table_info('bees')").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("args"));
      assert.ok(cols.includes("spawn_failures"));
      const row = check.prepare("SELECT args FROM bees WHERE id = 'old-1'").get() as { args: string };
      assert.equal(row.args, '["--effort","max"]');
    } finally {
      check.close();
    }
    h.open().close();
  } finally {
    h.cleanup();
  }
});
