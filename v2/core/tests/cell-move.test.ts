/**
 * v22 Cell→checkout move aggregate: admission, fences, CAS placement,
 * receipts after fail/complete, instruction persistence, retained-cell
 * identity across bee delete, audit replay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  IdempotencyConflictError,
  IllegalTransitionError,
  MoveInProgressError,
  SCHEMA_VERSION,
  StalePlacementError,
  composeDeveloperInstructions,
  hashBeeMoveRequest,
  openCoreStore,
  replayAudit,
  type CellRow,
} from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

function putActiveCell(store: ReturnType<ReturnType<typeof harness>["open"]>, beeId: string, cwd: string): CellRow {
  return store.putCell({
    sourceBeeId: beeId,
    originRepo: "/tmp/origin",
    sha: "abc",
    wrapper: "w",
    spaceName: "repo-space-c1",
    spaceDir: cwd,
    gitCommonDirRealpath: "/tmp/origin/.git",
    objectFormat: "sha1",
  });
}

test("cell-move.admit: CAS, idempotency, fence, operator stop supersedes and keeps failed receipt", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({
      name: "c",
      agent: "claude",
      substrate: "cell",
      cwd: "/tmp/cell-space",
    });
    const cell = putActiveCell(store, bee.id, bee.cwd);
    const dest = {
      kind: "local_checkout" as const,
      cwd: "/tmp/checkout",
      repository: { version: 1 as const, gitCommonDirRealpath: "/tmp/origin/.git", objectFormat: "sha1" as const },
      observedHead: "abc",
    };
    const hash = hashBeeMoveRequest({
      beeId: bee.id,
      expected: { placementVersion: 0, cellId: cell.id },
      destination: dest,
    });
    const admitted = store.admitBeeMove({
      beeId: bee.id,
      idempotencyKey: "k1",
      requestHash: hash,
      expected: { placementVersion: 0, cellId: cell.id },
      destinationCwd: dest.cwd,
    });
    assert.equal(admitted.phase, "stopping");
    assert.deepEqual(store.listActiveBeeMoves().map((move) => move.id), [admitted.id]);
    assert.equal(store.getBee(bee.id)?.activeMoveId, admitted.id);
    const sentWhileBooting = store.send(bee.id, "hello");
    assert.equal(sentWhileBooting.wakeCommand, null);
    assert.equal(store.enqueueWake(bee.id).outcome, "fenced");
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_system" });
    assert.equal(store.enqueueWake(bee.id).outcome, "fenced");
    const publicMove = store.listBeeViewRows().find((r) => r.bee.id === bee.id)?.move;
    assert.equal(publicMove?.id, admitted.id);
    assert.equal(publicMove && "requestHash" in publicMove, false);
    assert.equal(publicMove && "idempotencyKey" in publicMove, false);
    const again = store.admitBeeMove({
      beeId: bee.id,
      idempotencyKey: "k1",
      requestHash: hash,
      expected: { placementVersion: 0, cellId: cell.id },
      destinationCwd: dest.cwd,
    });
    assert.equal(again.id, admitted.id);
    assert.throws(
      () =>
        store.admitBeeMove({
          beeId: bee.id,
          idempotencyKey: "k1",
          requestHash: hash + "x",
          expected: { placementVersion: 0, cellId: cell.id },
          destinationCwd: dest.cwd,
        }),
      IdempotencyConflictError,
    );
    assert.throws(
      () =>
        store.admitBeeMove({
          beeId: bee.id,
          idempotencyKey: "k2",
          requestHash: hash,
          expected: { placementVersion: 0, cellId: cell.id },
          destinationCwd: dest.cwd,
        }),
      MoveInProgressError,
    );
    assert.throws(
      () =>
        store.admitBeeMove({
          beeId: bee.id,
          idempotencyKey: "k-stale",
          requestHash: hash,
          expected: { placementVersion: 9, cellId: cell.id },
          destinationCwd: dest.cwd,
        }),
      (err: unknown) => err instanceof StalePlacementError || err instanceof MoveInProgressError,
    );

    store.enqueueCommand("stop", bee.id, { cause: "stopped_by_user" });
    assert.equal(store.getBee(bee.id)?.activeMoveId, null);
    assert.deepEqual(store.listActiveBeeMoves(), [], "failed receipts are not reconciliation work");
    const receipt = store.latestMoveOf(bee.id);
    assert.equal(receipt?.phase, "failed");
    assert.equal(receipt?.failure?.code, "superseded");
    const row = store.listBeeViewRows().find((r) => r.bee.id === bee.id);
    assert.equal(row?.move?.id, admitted.id);
    assert.equal(row?.move?.phase, "failed");
    assert.equal(row?.move && "requestHash" in row.move, false);
    // Source is already stopped: the operator stop settles as a no-op and the
    // fenced send re-arms a wake in the same unfence transaction.
    const claimed = store.claimNextCommand();
    assert.ok(claimed);
    assert.equal(claimed.verb, "send_wake");
    const wake = store.enqueueWake(bee.id);
    assert.ok(wake.outcome === "pending" || wake.outcome === "enqueued", wake.outcome);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    h.cleanup();
  }
});

test("cell-move.placement: CAS source stopped, legal transitions, instructions survive dest fail", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({
      name: "c",
      agent: "codex",
      substrate: "cell",
      cwd: "/tmp/cell-space",
    });
    const cell = putActiveCell(store, bee.id, bee.cwd);
    const hash = hashBeeMoveRequest({
      beeId: bee.id,
      expected: { placementVersion: 0, cellId: cell.id },
      destination: {
        kind: "local_checkout",
        cwd: "/tmp/checkout",
        repository: { version: 1, gitCommonDirRealpath: "/tmp/origin/.git", objectFormat: "sha1" },
        observedHead: "abc",
      },
    });
    const move = store.admitBeeMove({
      beeId: bee.id,
      idempotencyKey: "place",
      requestHash: hash,
      expected: { placementVersion: 0, cellId: cell.id },
      destinationCwd: "/tmp/checkout",
    });
    assert.throws(() => store.commitBeePlacement(move.id), IllegalTransitionError);
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_system" });
    assert.throws(() => store.commitBeePlacement(move.id), /not placing/);
    store.setBeeMovePhase(move.id, "placing");
    const started = store.commitBeePlacement(move.id);
    assert.equal(started.phase, "starting");
    assert.equal(store.getBee(bee.id)?.substrate, "hsr");
    assert.equal(store.getBee(bee.id)?.cwd, "/tmp/checkout");
    assert.equal(store.getBee(bee.id)?.placementVersion, 1);
    assert.equal(store.getCell(cell.id)?.state, "retained");
    const replayed = store.commitBeePlacement(move.id);
    assert.equal(replayed.phase, "starting");

    store.failBeeMove(move.id, { stage: "start", code: "spawn_failed", detail: "dest boot failed" });
    assert.equal(store.getBee(bee.id)?.activeMoveId, null);
    const failed = store.latestMoveOf(bee.id);
    assert.equal(failed?.phase, "failed");
    assert.equal(failed?.instructionsPending, true);
    assert.equal(failed?.instructionsApplied, false);
    assert.equal(store.placementInstructionMove(bee.id)?.id, move.id);
    assert.equal(store.listBeeViewRows()[0]?.move?.phase, "failed");

    assert.throws(() => store.completeBeeMove(move.id), IllegalTransitionError);
    assert.throws(() => store.setBeeMovePhase(move.id, "starting"), IllegalTransitionError);

    const marked = store.markMoveInstructionsApplied(move.id);
    assert.equal(marked.instructionsApplied, true);
    assert.equal(store.placementInstructionMove(bee.id), null);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    assert.ok(store.dumpState().beeMoves[0]?.requestHash);
    assert.ok(store.dumpState().beeMoves[0]?.stopCommandKey);
  } finally {
    h.cleanup();
  }
});

test("cell-move.stale stop queued before admit does not cancel the move", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({ name: "c", agent: "claude", substrate: "cell", cwd: "/tmp/cell-space" });
    const cell = putActiveCell(store, bee.id, bee.cwd);
    store.enqueueCommand("stop", bee.id, { cause: "stopped_by_system", reason: "hang_policy" });
    store.enqueueCommand("stop", bee.id, { cause: "stopped_by_system", thenRevive: true });
    const hash = hashBeeMoveRequest({
      beeId: bee.id,
      expected: { placementVersion: 0, cellId: cell.id },
      destination: {
        kind: "local_checkout",
        cwd: "/tmp/checkout",
        repository: { version: 1, gitCommonDirRealpath: "/tmp/origin/.git", objectFormat: "sha1" },
        observedHead: "abc",
      },
    });
    const move = store.admitBeeMove({
      beeId: bee.id,
      idempotencyKey: "after-stale",
      requestHash: hash,
      expected: { placementVersion: 0, cellId: cell.id },
      destinationCwd: "/tmp/checkout",
    });
    assert.equal(store.getBee(bee.id)?.activeMoveId, move.id);
    const thenRevive = store.listCommands({ beeId: bee.id }).find((c) => c.args.thenRevive === true);
    assert.equal(thenRevive?.status, "done");
    const claimed = store.claimNextCommand();
    assert.ok(claimed);
    assert.equal(store.getBee(bee.id)?.activeMoveId, move.id);
    assert.equal(store.latestMoveOf(bee.id)?.phase, "stopping");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    h.cleanup();
  }
});

test("cell-move.pre-placement fail unfences and does not keep instructions", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({ name: "c", agent: "claude", substrate: "cell", cwd: "/tmp/cell-space" });
    const cell = putActiveCell(store, bee.id, bee.cwd);
    const hash = hashBeeMoveRequest({
      beeId: bee.id,
      expected: { placementVersion: 0, cellId: cell.id },
      destination: {
        kind: "local_checkout",
        cwd: "/tmp/checkout",
        repository: { version: 1, gitCommonDirRealpath: "/tmp/origin/.git", objectFormat: "sha1" },
        observedHead: "abc",
      },
    });
    const move = store.admitBeeMove({
      beeId: bee.id,
      idempotencyKey: "pre",
      requestHash: hash,
      expected: { placementVersion: 0, cellId: cell.id },
      destinationCwd: "/tmp/checkout",
    });
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_system" });
    store.failBeeMove(move.id, { stage: "context", code: "transcript_unavailable", detail: "missing" });
    assert.equal(store.getBee(bee.id)?.activeMoveId, null);
    assert.equal(store.getBee(bee.id)?.substrate, "cell");
    assert.equal(store.placementInstructionMove(bee.id), null);
    assert.equal(store.latestMoveOf(bee.id)?.instructionsPending, false);
    store.send(bee.id, "hello");
    assert.equal(store.enqueueWake(bee.id).outcome, "pending");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    h.cleanup();
  }
});

test("cell-move.deleteBee keeps retained cell identity", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({ name: "c", agent: "claude", substrate: "cell", cwd: "/tmp/cell-space" });
    const cell = putActiveCell(store, bee.id, bee.cwd);
    store.retainCell(cell.id);
    store.deleteBee(bee.id);
    const kept = store.getCell(cell.id);
    assert.equal(kept?.state, "retained");
    assert.equal(kept?.spaceDir, "/tmp/cell-space");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    h.cleanup();
  }
});

for (const previousVersion of [20, 21]) {
test(`cell-move.schema v${previousVersion} store migrates to v22`, () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '${previousVersion}');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
        provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
        spawn_failures INTEGER NOT NULL DEFAULT 0, args TEXT, parent_id TEXT, forked_from TEXT,
        fork_seed TEXT, account TEXT, handle TEXT
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at, handle)
        VALUES('old-1','old','claude','hsr','/tmp','active',5,'CL.old1');
    `);
    if (previousVersion === 21) {
      db.exec("ALTER TABLE bees ADD COLUMN parent_external INTEGER NOT NULL DEFAULT 0");
      db.exec("UPDATE bees SET parent_id = 'external-parent', parent_external = 1 WHERE id = 'old-1'");
    }
    db.close();
    const store = h.open();
    const old = store.getBee("old-1");
    assert.equal(old?.parentExternal, previousVersion === 21);
    assert.equal(old?.parentId, previousVersion === 21 ? "external-parent" : null);
    assert.equal(old?.placementVersion, 0);
    assert.equal(old?.activeMoveId, null);
    assert.equal(old?.cellId, null);
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      assert.equal(Number(version.value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 22);
      const cols = (check.prepare("SELECT name FROM pragma_table_info('bees')").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("placement_version"));
      assert.ok(cols.includes("active_move_id"));
      assert.ok(cols.includes("cell_id"));
      const idx = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'bees_one_active_move'").get() as
        | { name: string }
        | undefined;
      assert.equal(idx?.name, "bees_one_active_move");
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});
}

test("cell-move.unfence re-arms a wake for mail accepted during the fence", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({ name: "c", agent: "claude", substrate: "cell", cwd: "/tmp/cell-space" });
    const cell = putActiveCell(store, bee.id, bee.cwd);
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_system" });
    const hash = hashBeeMoveRequest({
      beeId: bee.id,
      expected: { placementVersion: 0, cellId: cell.id },
      destination: {
        kind: "local_checkout",
        cwd: "/tmp/checkout",
        repository: { version: 1, gitCommonDirRealpath: "/tmp/origin/.git", objectFormat: "sha1" },
        observedHead: "abc",
      },
    });
    const move = store.admitBeeMove({
      beeId: bee.id,
      idempotencyKey: "f1",
      requestHash: hash,
      expected: { placementVersion: 0, cellId: cell.id },
      destinationCwd: "/tmp/checkout",
    });
    const sent = store.send(bee.id, "after-admit");
    assert.equal(sent.wakeCommand, null);
    assert.equal(store.enqueueWake(bee.id).outcome, "fenced");
    store.failBeeMove(move.id, { stage: "context", code: "transcript_unavailable", detail: "missing" });
    assert.equal(store.getBee(bee.id)?.activeMoveId, null);
    const wakes = store.listCommands({ beeId: bee.id, status: "queued" }).filter((c) => c.verb === "send_wake");
    assert.equal(wakes.length, 1);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    h.cleanup();
  }
});

test("cell-move.dumpState beeMoves order matches audit replay", () => {
  const h = harness();
  const store = h.open();
  try {
    const dest = {
      kind: "local_checkout" as const,
      cwd: "/tmp/checkout",
      repository: { version: 1 as const, gitCommonDirRealpath: "/tmp/origin/.git", objectFormat: "sha1" as const },
      observedHead: "abc",
    };
    for (const name of ["a", "b"]) {
      const { bee } = store.createBee({ name, agent: "claude", substrate: "cell", cwd: `/tmp/cell-${name}` });
      const cell = putActiveCell(store, bee.id, bee.cwd);
      const hash = hashBeeMoveRequest({
        beeId: bee.id,
        expected: { placementVersion: 0, cellId: cell.id },
        destination: dest,
      });
      store.admitBeeMove({
        beeId: bee.id,
        idempotencyKey: `k-${name}`,
        requestHash: hash,
        expected: { placementVersion: 0, cellId: cell.id },
        destinationCwd: dest.cwd,
      });
    }
    assert.equal(store.dumpState().beeMoves.length, 2);
    assert.ok(store.dumpState().beeMoves[0]?.requestHash);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    h.cleanup();
  }
});

test("cell-move.latest receipt follows insertion order when admission timestamps tie", () => {
  const h = harness();
  let store = openCoreStore(h.path, { now: () => 1_000, ephemeral: true });
  try {
    const { bee } = store.createBee({
      name: "same-millisecond",
      agent: "codex",
      substrate: "cell",
      cwd: "/tmp/cell-space",
    });
    const cell = putActiveCell(store, bee.id, bee.cwd);
    const admit = (idempotencyKey: string) => store.admitBeeMove({
      beeId: bee.id,
      idempotencyKey,
      requestHash: idempotencyKey,
      expected: { placementVersion: 0, cellId: cell.id },
      destinationCwd: "/tmp/checkout",
    });
    const older = admit("older");
    store.failBeeMove(older.id, { stage: "validate", code: "older_failed", detail: "fixture" });
    const newer = admit("newer");
    store.close();

    const db = new DatabaseSync(h.path);
    try {
      db.prepare("UPDATE bee_moves SET id = 'zzzz-old' WHERE id = ?").run(older.id);
      db.prepare("UPDATE bee_moves SET id = 'aaaa-new' WHERE id = ?").run(newer.id);
      db.prepare("UPDATE bees SET active_move_id = 'aaaa-new' WHERE id = ?").run(bee.id);
    } finally {
      db.close();
    }

    store = openCoreStore(h.path, { now: () => 1_000, ephemeral: true });
    assert.equal(store.latestMoveOf(bee.id)?.id, "aaaa-new");
    assert.equal(store.placementInstructionMove(bee.id)?.id, "aaaa-new");
    assert.equal(store.listBeeViewRows()[0]?.move?.id, "aaaa-new");
  } finally {
    store.close();
    h.cleanup();
  }
});

test("cell-move.starting dest stop does not fence boot retries", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({ name: "c", agent: "codex", substrate: "cell", cwd: "/tmp/cell-space" });
    const cell = putActiveCell(store, bee.id, bee.cwd);
    const hash = hashBeeMoveRequest({
      beeId: bee.id,
      expected: { placementVersion: 0, cellId: cell.id },
      destination: {
        kind: "local_checkout",
        cwd: "/tmp/checkout",
        repository: { version: 1, gitCommonDirRealpath: "/tmp/origin/.git", objectFormat: "sha1" },
        observedHead: "abc",
      },
    });
    const move = store.admitBeeMove({
      beeId: bee.id,
      idempotencyKey: "start-retry",
      requestHash: hash,
      expected: { placementVersion: 0, cellId: cell.id },
      destinationCwd: "/tmp/checkout",
    });
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_system" });
    store.setBeeMovePhase(move.id, "placing");
    store.commitBeePlacement(move.id);
    assert.equal(store.activeMoveOf(bee.id)?.phase, "starting");
    const retry = store.enqueueBootRetry(bee.id);
    assert.notEqual(retry.outcome, "fenced");
    assert.ok(retry.outcome === "enqueued" || retry.outcome === "pending", retry.outcome);
    // Source was marked stopped without executing the move-owned stop; claim
    // settles that stop as already_stopped and surfaces dest start work.
    const claimed = store.claimNextCommand();
    assert.ok(claimed);
    assert.ok(claimed.verb === "revive" || claimed.verb === "send_wake", claimed.verb);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    h.cleanup();
  }
});

test("cell-move.composeDeveloperInstructions preserves existing custom text", () => {
  const overlay = "Workspace placement changed (version 1).";
  assert.equal(composeDeveloperInstructions(null, overlay), overlay);
  assert.equal(composeDeveloperInstructions("  ", overlay), overlay);
  assert.equal(composeDeveloperInstructions("keep me", null), "keep me");
  assert.equal(composeDeveloperInstructions("keep me", overlay), `keep me\n\n${overlay}`);
  assert.equal(composeDeveloperInstructions(`keep me\n\n${overlay}`, overlay), `keep me\n\n${overlay}`);
  assert.equal(composeDeveloperInstructions(undefined, undefined), undefined);
});

test("cell-move.discovery: scans active pointers, preserves receipt order and rollback", () => {
  const h = harness();
  const store = h.open();
  try {
    const create = (name: string) => {
      const { bee } = store.createBee({ name, agent: "claude", substrate: "cell", cwd: `/tmp/${name}` });
      const cell = putActiveCell(store, bee.id, bee.cwd);
      return (key: string) => store.admitBeeMove({
        beeId: bee.id,
        idempotencyKey: key,
        requestHash: key,
        expected: { placementVersion: 0, cellId: cell.id },
        destinationCwd: "/tmp/checkout",
      });
    };
    const first = create("discovery-first");
    for (let i = 0; i < 64; i++) {
      const receipt = first(`history-${i}`);
      store.failBeeMove(receipt.id, { stage: "context", code: "transcript_unavailable", detail: "fixture" });
    }
    const active = [first("active-first"), create("discovery-second")("active-second")]
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    // Capture the actual production query before its first cached preparation.
    let discoverySql = "";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql.includes("SELECT m.* FROM bees b JOIN bee_moves m")) discoverySql = sql;
      return prepare.call(this, sql);
    };
    try {
      assert.deepEqual(store.listActiveBeeMoves(), active);
    } finally {
      DatabaseSync.prototype.prepare = prepare;
    }
    assert.ok(discoverySql, "the discovery query must be observed");
    assert.throws(() => store.transact(() => {
      for (const move of active) {
        store.failBeeMove(move.id, { stage: "context", code: "transcript_unavailable", detail: "rollback" });
      }
      assert.deepEqual(store.listActiveBeeMoves(), []);
      throw new Error("rollback discovery");
    }), /rollback discovery/);
    assert.deepEqual(store.listActiveBeeMoves(), active);
    store.close();

    const db = new DatabaseSync(h.path, { readOnly: true });
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${discoverySql}`).all().map((row) => String(row.detail));
      assert.ok(plan.some((line) => line.includes("bees_one_active_move")), plan.join("\n"));
      assert.ok(!plan.some((line) => /\bSCAN m\b/.test(line)), "discovery must not walk retained move history:\n" + plan.join("\n"));
    } finally {
      db.close();
    }
    const reopened = h.open();
    assert.deepEqual(reopened.listActiveBeeMoves(), active);
    reopened.close();
  } finally {
    h.cleanup();
  }
});
