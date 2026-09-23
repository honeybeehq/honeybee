import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveDaemon } from "../src/daemon.ts";
import type { ThreadOperationResult } from "../src/protocol.ts";
import { threadFixture } from "./thread-fixture.ts";

for (const kind of ["fork", "handoff"] as const) {
  test(`${kind}: replay pre-allocation receipts after reopening, without accepting changed intent`, t => {
    const fixture = threadFixture(t, kind);
    const shape = { kind, sourceBeeId: "source", sourceProviderSessionId: fixture.row.sourceProviderSessionId,
      instruction: fixture.row.instruction, name: null };
    // This is the exact persisted pre-v28 request hash. Change only the owned
    // fixture's historical receipt, then reopen it as an upgraded daemon does.
    const legacyHash = createHash("sha256").update(JSON.stringify(shape)).digest("hex");
    const db = (fixture.store as unknown as { db: DatabaseSync }).db;
    db.prepare("UPDATE thread_operations SET row_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...fixture.row, requestHash: legacyHash }), fixture.row.id);
    fixture.restart();
    // Exercise the real admission/replay method without starting native workers.
    const daemon = Object.assign(Object.create(HiveDaemon.prototype), { store: fixture.store }) as {
      rpcThreadOperation(kind: "fork" | "handoff", params: Record<string, unknown>): ThreadOperationResult;
    };
    const params = { beeId: "source", sourceProviderSessionId: shape.sourceProviderSessionId,
      ...(kind === "handoff" ? { instruction: shape.instruction } : {}), idempotencyKey: "key" };
    const before = fixture.store.dumpState();
    const replay = daemon.rpcThreadOperation(kind, params);
    assert.equal(replay.deduped, true);
    assert.equal(replay.operation.id, fixture.row.id);
    assert.equal(replay.operation.successorBeeId, "successor");
    assert.deepEqual(fixture.store.dumpState(), before);
    for (const changes of [{ name: "different" }, { successorBeeId: "different" },
      { sourceProviderSessionId: "different" }, ...(kind === "handoff" ? [{ instruction: "different" }] : [])]) {
      assert.throws(() => daemon.rpcThreadOperation(kind, { ...params, ...changes }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "idempotency_conflict");
    }
    assert.deepEqual(fixture.store.dumpState(), before);
  });
}
