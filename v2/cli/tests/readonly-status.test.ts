import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness } from "../../core/tests/helpers.ts";
import { BEE_HANDOFFS_TABLE_SQL, BEE_MOVES_TABLE_SQL, CELLS_TABLE_SQL } from "../../core/src/schema.ts";
import { ReadOnlyStore } from "../src/readonly.ts";

function fixture(count = 1) {
  const h = harness();
  const core = h.open();
  for (let i = 0; i < count; i++) {
    core.createBee({ id: `bee-${i}`, name: `bee-${i}`, agent: "stub", substrate: "hsr", cwd: "/tmp" });
  }
  core.close();
  return h;
}

test("status listing prepares a bounded set of plans across different bee ids", () => {
  const h = fixture(40);
  const original = DatabaseSync.prototype.prepare;
  let prepares = 0;
  const reader = new ReadOnlyStore(h.path);
  try {
    DatabaseSync.prototype.prepare = function (sql: string) {
      prepares++;
      return original.call(this, sql);
    };
    assert.equal(reader.list(null).length, 40);
    assert.ok(prepares <= 7, `listing compiled ${prepares} statements`);
    const before = prepares;
    for (let i = 0; i < 40; i++) assert.equal(reader.view(`bee-${i}`).bee?.id, `bee-${i}`);
    assert.equal(prepares, before, "new bee ids reuse the same plans");
  } finally {
    DatabaseSync.prototype.prepare = original;
    reader.close();
    h.cleanup();
  }
});

test("prepared status reads stay fresh, detached and generation ordered across writes and rollback", () => {
  const h = fixture();
  const reader = new ReadOnlyStore(h.path);
  const writer = new DatabaseSync(h.path);
  try {
    const first = reader.view("bee-0");
    assert.equal(first.runtime?.generation, 1);
    writer.exec("UPDATE bees SET name = 'fresh', tags = '[\"updated\"]' WHERE id = 'bee-0'");
    writer.exec("INSERT INTO runtimes(bee_id, generation, state, exit_cause, started_at, updated_at) VALUES('bee-0', 2, 'stopped', 'clean', 2, 2)");
    writer.exec("INSERT INTO flags(bee_id, flag, detail, set_at) VALUES('bee-0', 'resource_blocked', 'a', 1), ('bee-0', 'auth_needed', 'b', 2)");
    const second = reader.view("bee-0");
    assert.equal(second.bee?.name, "fresh");
    assert.equal(second.runtime?.generation, 2);
    assert.equal(second.view.generation, 2);
    assert.deepEqual(reader.activeFlags("bee-0"), ["resource_blocked", "auth_needed"]);
    second.bee!.tags.push("mutated");
    second.runtime!.generation = 90;
    assert.deepEqual(reader.getBee("bee-0")?.tags, ["updated"]);
    assert.equal(reader.currentRuntime("bee-0")?.generation, 2);
    writer.exec("BEGIN; UPDATE bees SET name = 'rolled back'; ROLLBACK;");
    assert.equal(reader.getBee("bee-0")?.name, "fresh");
    writer.exec("UPDATE flags SET cleared_at = 3 WHERE flag = 'resource_blocked'");
    assert.deepEqual(reader.activeFlags("bee-0"), ["auth_needed"]);
    assert.equal(first.bee?.name, "bee-0", "old results are detached");
  } finally { writer.close(); reader.close(); h.cleanup(); }
});

test("optional tables remain lazy and a later schema migration is visible on the same reader", () => {
  const h = fixture();
  const writer = new DatabaseSync(h.path);
  writer.exec("DROP TABLE bee_moves; DROP TABLE cells; DROP TABLE bee_handoffs; UPDATE bees SET cell_id = 'cell-1'");
  const reader = new ReadOnlyStore(h.path);
  try {
    assert.equal(reader.view("bee-0").move, null);
    assert.equal(reader.view("bee-0").cell, null);
    assert.equal(reader.view("bee-0").handoff, null);
    writer.exec(CELLS_TABLE_SQL);
    writer.exec(BEE_MOVES_TABLE_SQL);
    writer.exec(BEE_HANDOFFS_TABLE_SQL);
    writer.exec("INSERT INTO bee_handoffs(id, bee_id, idempotency_key, request_hash, phase, source_generation, from_agent, from_segment_id, to_agent, stop_at, stop_command_key, revive_command_key, created_at, updated_at) VALUES('handoff-1', 'bee-0', 'handoff-1', 'hash', 'starting', 1, 'stub', 'segment-1', 'stub', 'idle', 'stop', 'revive', 1, 1)");
    const handoff = reader.view("bee-0").handoff;
    assert.equal(handoff?.phase, "starting");
    writer.exec("UPDATE bee_handoffs SET phase = 'complete', target_generation = 2 WHERE id = 'handoff-1'");
    assert.equal(reader.view("bee-0").handoff?.phase, "complete");
    assert.equal(reader.view("bee-0").handoff?.targetGeneration, 2);
    assert.equal(handoff?.phase, "starting", "cached handoff plans still return detached, fresh rows");
    writer.exec("INSERT INTO cells(id, source_bee_id, state, git_common_dir, object_format, origin_repo, sha, wrapper, space_name, space_dir, created_at) VALUES('cell-1', 'bee-0', 'retained', '/tmp/repo/.git', 'sha1', 'example/repo', 'abc', 'wrapper', 'space', '/tmp/space', 1)");
    const insertMove = writer.prepare("INSERT INTO bee_moves(id, bee_id, idempotency_key, request_hash, phase, source_generation, from_cwd, from_substrate, to_cwd, retained_cell_id, stop_command_key, revive_command_key, placement_version, created_at, updated_at) VALUES(?, 'missing', ?, 'hash', 'complete', 1, '/tmp/from', 'cell', '/tmp/to', 'cell-1', 'stop', 'revive', 2, ?, 2)");
    insertMove.run("older", "older", 1);
    insertMove.run("newer", "newer", 2);
    assert.equal(reader.view("bee-0").cell?.state, "retained");
    assert.equal(reader.view("missing").bee, null);
    assert.equal(reader.view("missing").move?.id, "newer", "orphan move remains visible for a missing bee");
    writer.exec("UPDATE cells SET state = 'removed' WHERE id = 'cell-1'");
    assert.equal(reader.view("bee-0").cell?.state, "removed");
    writer.exec("ALTER TABLE bees ADD COLUMN extra_fixture_column TEXT");
    assert.equal(reader.getBee("bee-0")?.id, "bee-0", "SELECT * re-prepares after a schema change");
  } finally { reader.close(); writer.close(); h.cleanup(); }
});

test("read-only isolation and close semantics survive statement reuse", () => {
  const a = fixture();
  const b = fixture();
  const writer = new DatabaseSync(b.path);
  writer.exec("UPDATE bees SET name = 'other-store'");
  writer.close();
  const left = new ReadOnlyStore(a.path);
  const right = new ReadOnlyStore(b.path);
  try {
    assert.equal(left.getBee("bee-0")?.name, "bee-0");
    assert.equal(right.getBee("bee-0")?.name, "other-store");
    const db = Reflect.get(left, "db") as DatabaseSync;
    assert.throws(() => db.exec("UPDATE bees SET name = 'forbidden'"), /readonly|read.only/i);
    left.close();
    assert.doesNotThrow(() => left.close());
    assert.throws(() => left.getBee("bee-0"), /closed|not open|finalized/i);
    const reopened = new ReadOnlyStore(a.path);
    try { assert.equal(reopened.getBee("bee-0")?.name, "bee-0"); }
    finally { reopened.close(); }
    assert.equal(right.getBee("bee-0")?.name, "other-store");
  } finally { left.close(); right.close(); a.cleanup(); b.cleanup(); }
});
