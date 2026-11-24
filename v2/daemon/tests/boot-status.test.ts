import assert from "node:assert/strict";
import { test } from "node:test";
import { BootStatus, ETA_MIN_ELAPSED_MS, verifyToBackupTimeRatio } from "../src/bootStatus.ts";

const VERIFY_TO_BACKUP_TIME_RATIO = verifyToBackupTimeRatio(1.3 * 1_000_000_000);
import { describeStartingBoot } from "../src/protocol.ts";

const GB = 1_000_000_000;

test("boot status reports phase, progress and an ETA from the measured backup rate", () => {
  let now = 1_000;
  const status = new BootStatus(500, () => now);
  const upgrade = { schemaFrom: 61, schemaTo: 62 };
  status.storeProgress({ ...upgrade, phase: "store_backup", bytesDone: 0, bytesTotal: 1.3 * GB });
  assert.deepEqual(status.starting(), { state: "starting", phase: "store_backup", phaseStartedAt: 1_000, schemaFrom: 61, schemaTo: 62, progress: { bytesDone: 0, bytesTotal: 1.3 * GB, fraction: 0 }, etaMs: null });

  now += ETA_MIN_ELAPSED_MS - 1;
  status.storeProgress({ ...upgrade, phase: "store_backup", bytesDone: 0.5 * GB, bytesTotal: 1.3 * GB });
  assert.equal(status.starting()!.etaMs, null, "no estimate before enough time has passed");

  now = 1_000 + 10_000;
  status.storeProgress({ ...upgrade, phase: "store_backup", bytesDone: 0.65 * GB, bytesTotal: 1.3 * GB });
  const halfway = status.starting()!;
  assert.equal(halfway.phaseStartedAt, 1_000, "progress within a phase keeps its start");
  assert.equal(halfway.progress!.fraction, 0.5);
  assert.equal(halfway.etaMs, Math.round(10_000 + VERIFY_TO_BACKUP_TIME_RATIO * 20_000));

  now = 1_000 + 20_000;
  status.storeProgress({ ...upgrade, phase: "store_backup_verify", bytesDone: null, bytesTotal: null });
  const verify = status.starting()!;
  assert.equal(verify.phase, "store_backup_verify");
  assert.equal(verify.phaseStartedAt, now);
  assert.equal(verify.progress, null);
  assert.equal(verify.etaMs, Math.round(VERIFY_TO_BACKUP_TIME_RATIO * 20_000));
  now += VERIFY_TO_BACKUP_TIME_RATIO * 20_000 + 1;
  assert.equal(status.starting()!.etaMs, null, "an overrun estimate becomes unknown, never negative");

  status.storeProgress({ ...upgrade, phase: "store_migrate", bytesDone: null, bytesTotal: null });
  assert.equal(status.starting()!.etaMs, null);
  status.reconciling();
  assert.deepEqual({ ...status.starting()!, phaseStartedAt: 0 }, { state: "starting", phase: "boot_reconcile", phaseStartedAt: 0, schemaFrom: null, schemaTo: null, progress: null, etaMs: null });

  const health = status.startingHealth()!;
  assert.deepEqual(Object.keys(health).sort(), ["boot", "pid", "protocol", "startedAt", "uptimeMs"]);
  assert.equal(health.startedAt, 500);
  assert.equal(health.uptimeMs, now - 500);

  status.ready();
  assert.equal(status.starting(), null);
  assert.equal(status.startingHealth(), null);
  assert.deepEqual(status.readyBoot, { state: "ready", readyAt: now });
});

test("the verify estimate grows with store size the way integrity_check was measured to", () => {
  assert.equal(verifyToBackupTimeRatio(100_000_000), 5.0);
  assert.equal(verifyToBackupTimeRatio(400_000_000), 5.0);
  assert.equal(verifyToBackupTimeRatio(1_300_000_000), 5.9);
  assert.equal(verifyToBackupTimeRatio(3_000_000_000), 6.2);
  assert.equal(verifyToBackupTimeRatio(10_000_000_000), 6.2);
  const between = verifyToBackupTimeRatio(800_000_000);
  assert.ok(between > 5.0 && between < 5.9);
});

test("starting boot facts read as one plain sentence", () => {
  assert.equal(
    describeStartingBoot({ state: "starting", phase: "store_backup", phaseStartedAt: 0, schemaFrom: 61, schemaTo: 62, progress: { bytesDone: 560_000_000, bytesTotal: 1_305_690_112, fraction: 0.429 }, etaMs: 130_000 }, 41_000),
    "Honeybee is starting: backing up the store before the schema 61→62 upgrade, 560 MB of 1.3 GB (42%), about 2 min left (41s in this step). Sessions keep running.",
  );
  assert.equal(
    describeStartingBoot({ state: "starting", phase: "boot_reconcile", phaseStartedAt: 0, schemaFrom: null, schemaTo: null, progress: null, etaMs: null }, 2_000),
    "Honeybee is starting: re-adopting sessions (2s in this step). Sessions keep running.",
  );
});
