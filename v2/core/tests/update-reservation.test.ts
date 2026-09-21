import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../src/index.ts";

const request = { id: "update-a", recoverySubjectDigest: `sha256:${"a".repeat(64)}`, expectedEpoch: 0 };
test("update reservation is durable, fences enrollment, and stale owners cannot release or reacquire", () => {
  const dir = mkdtempSync(join(tmpdir(), "hon8-reservation-"));
  let store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  try {
    store.createAccount({ id: "test-account", label: "test", harness: "claude", homePath: join(dir, "home") });
    const first = store.reserveUpdate(request);
    assert.deepEqual(store.reserveUpdate(request), first);
    assert.throws(() => store.putAccountCredentialAuthority({ account: "test-account", phase: "enrolling", generation: 1, expiresAt: null, operationKey: null }), /update.*reserved/);
    store.close();
    store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    assert.deepEqual(store.updateReservation(), first);
    assert.throws(() => store.releaseUpdate({ ...first, id: "wrong" }), /reservation.*mismatch/);
    store.releaseUpdate(first);
    store.releaseUpdate(first); // Lost response retry.
    assert.throws(() => store.reserveUpdate(request), /epoch/);
    const second = store.reserveUpdate({ ...request, id: "update-b", expectedEpoch: first.epoch });
    assert.throws(() => store.releaseUpdate(first), /reservation.*mismatch/);
    store.releaseUpdate(second);
    store.putAccountCredentialAuthority({ account: "test-account", phase: "enrolling", generation: 1, expiresAt: null, operationKey: null });
    assert.throws(() => store.reserveUpdate({ ...request, expectedEpoch: second.epoch }), /credential authority/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
