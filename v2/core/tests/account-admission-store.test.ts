import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore, replayAudit, SCHEMA_VERSION } from "../src/index.ts";

test("admission store: reservations are durable, idempotent, and generation-reconciled", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-admission-store-"));
  const path = join(dir, "core.sqlite3");
  let now = 1_000;
  try {
    let store = openCoreStore(path, { now: () => now, ephemeral: true });
    const account = store.createAccount({ id: "codex-a", harness: "codex", homePath: join(dir, "home"), label: "a" });
    const first = store.reserveAccountAdmission({
      id: "reservation-1",
      requestKey: "request-1",
      scope: "openai:workspace",
      account: account.id,
      operation: "swap",
      units: 1,
      expiresAt: now + 60_000,
      reconcileAfterGeneration: 1,
      receipt: { version: 1, outcome: "selected", account: account.id },
    });
    const replay = store.reserveAccountAdmission({
      id: "ignored",
      requestKey: "request-1",
      scope: "openai:workspace",
      account: account.id,
      operation: "swap",
      units: 1,
      expiresAt: now + 60_000,
      reconcileAfterGeneration: 1,
      receipt: { version: 1, outcome: "selected", account: account.id },
    });
    assert.equal(replay.id, first.id);
    assert.equal(store.listUnreconciledAccountAdmissions(now).length, 1);
    assert.equal(first.confirmedAt, null);
    assert.equal(store.confirmAccountAdmission(first.id)?.confirmedAt, now);
    assert.equal(store.confirmAccountAdmission(first.id)?.confirmedAt, now, "confirm retries are idempotent");

    const { bee } = store.createBee({ name: "worker", agent: "codex", substrate: "hsr", cwd: "/tmp", account: account.id });
    store.bindAccountAdmission(first.id, bee.id);
    store.updateRuntimeState(bee.id, 1, "running", { pid: 1, pidStartedAt: 1 });
    assert.equal(store.listUnreconciledAccountAdmissions(now).length, 1, "the source generation still runs on the old account");
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_system" });
    store.reviveBee(bee.id, { proc: { pid: 2, pidStartedAt: 2 } });
    assert.equal(store.listUnreconciledAccountAdmissions(now).length, 0, "the target generation is authoritative; do not double count its reservation");
    const abandoned = store.reserveAccountAdmission({
      id: "reservation-abandoned", requestKey: "request-abandoned", scope: "openai:workspace", account: account.id,
      operation: "spawn", units: 1, expiresAt: now + 30_000, reconcileAfterGeneration: 0,
      receipt: { version: 1, outcome: "selected", account: account.id },
    });
    const released = store.reserveAccountAdmission({
      id: "reservation-release", requestKey: "request-release", scope: "openai:workspace", account: account.id,
      operation: "spawn", units: 1, expiresAt: now + 30_000, reconcileAfterGeneration: 0,
      receipt: { version: 1, outcome: "selected", account: account.id },
    });
    assert.equal(store.listUnreconciledAccountAdmissions(now).length, 2);
    assert.equal(store.releaseAccountAdmission(released.id)?.releasedAt, now);
    assert.equal(store.releaseAccountAdmission(released.id)?.releasedAt, now, "release retries are idempotent");
    assert.deepEqual(store.listUnreconciledAccountAdmissions(now).map((row) => row.id), [abandoned.id]);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState(), "admission receipts replay exactly");
    store.close();

    store = openCoreStore(path, { now: () => now, ephemeral: true });
    assert.equal(store.getAccountAdmissionByRequestKey("request-1")?.id, first.id, "receipt survives daemon restart");
    assert.equal(store.getAccountAdmission(first.id)?.confirmedAt, 1_000, "confirmation survives daemon restart");
    now += 60_001;
    assert.equal(store.listUnreconciledAccountAdmissions(now).length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admission store: a v27 database gains the reservation ledger without losing account state", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-admission-migration-"));
  const path = join(dir, "core.sqlite3");
  try {
    const initial = openCoreStore(path, { ephemeral: true });
    initial.createAccount({ id: "codex-old", harness: "codex", homePath: join(dir, "home"), label: "old" });
    initial.close();
    const old = new DatabaseSync(path);
    old.exec("DROP TABLE account_admission_reservations");
    old.prepare("UPDATE meta SET value = '27' WHERE key = 'schema_version'").run();
    old.close();

    const migrated = openCoreStore(path, { ephemeral: true });
    assert.equal(migrated.getAccount("codex-old")?.label, "old");
    assert.deepEqual(migrated.listAccountAdmissions(), []);
    migrated.close();
    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
    assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_admission_reservations'").get());
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
