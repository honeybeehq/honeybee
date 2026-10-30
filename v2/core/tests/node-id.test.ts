import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness } from "./helpers.ts";

test("node-id: minted once, stable across reopen, re-minted when the store wakes up on another machine with the old scope remembered", () => {
  const h = harness();
  try {
    const store = h.open();
    const first = store.nodeId();
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(store.nodeId(), first, "stable within a session");
    assert.deepEqual(store.wipNodeScopes(first), [first]);
    store.close();
    const again = h.open();
    assert.equal(again.nodeId(), first, "stable across reopen on the same machine");
    again.close();
    const db = new DatabaseSync(h.path);
    db.prepare("UPDATE meta SET value = 'other-host|-|/elsewhere/core.sqlite3' WHERE key = 'node_id_birth'").run();
    db.close();
    const moved = h.open();
    const minted = moved.nodeId();
    assert.notEqual(minted, first, "a store carried to another machine gets a new id");
    assert.deepEqual(moved.wipNodeScopes(minted), [first, minted], "the old scope stays on the sweep list");
    assert.equal(moved.nodeId(), minted);
    moved.close();
  } finally {
    h.cleanup();
  }
});
