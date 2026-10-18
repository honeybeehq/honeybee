import assert from "node:assert/strict";
import {test} from "node:test";
import {harness, makeBee} from "./helpers.ts";

test("retained cleanup is durable, deduplicated, informational on socket loss, and resolves once", () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store);
    const locator = {beeId: bee.id, generation: 1, reason: "ownership-unverified" as const, paneId: "%1", sessionId: "$1", windowId: "@1", socket: {dev: 1, ino: 2, parentDev: 1, parentIno: 3}};
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: 0, informational: 0});
    store.tmuxCleanupHooks().update(locator, "retained");
    store.tmuxCleanupHooks().update(locator, "retained");
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: 1, informational: 0});
    store.close(); store = h.open();
    assert.equal(store.tmuxCleanupHooks().entries().length, 1);
    store.tmuxCleanupHooks().update(locator, "socket-gone-unverifiable");
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: 0, informational: 1});
    store.tmuxCleanupHooks().update(locator, "retained");
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: 1, informational: 0});
    store.tmuxCleanupHooks().update(locator, "resolved");
    store.tmuxCleanupHooks().update(locator, "resolved");
    assert.deepEqual(store.tmuxCleanupCounts(), {retained: 0, informational: 0});
    const reports = store.auditTail(0, 1000).filter(row => row.kind.startsWith("runtime.tmux_cleanup_"));
    assert.equal(reports.filter(row => row.kind === "runtime.tmux_cleanup_retained").length, 2);
    assert.equal(reports.filter(row => row.kind === "runtime.tmux_cleanup_resolved").length, 1);
    for (const row of reports) assert.doesNotMatch(JSON.stringify(row.payload), /"(?:pid|path|argv)":/);
  } finally {store.close(); h.cleanup();}
});
