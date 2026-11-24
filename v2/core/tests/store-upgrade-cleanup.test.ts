import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openCoreStore, SCHEMA_VERSION } from "../src/index.ts";
import { openCoreStoreUpgrading, type AbandonedBackupCleanup } from "../src/storeUpgrade.ts";

const PARTIAL = "1795524148534-5a1a60f5-52e2-4b5c-bb7b-dc6ac2d96a98.partial";
const ORPHAN = "1795524148535-6b2b71f6-63f3-4c6d-cc8c-ed7bd3ea7b09.partial";

function labStore(previousSchema: boolean): { dir: string; store: string; backups: string } {
  const dir = mkdtempSync(join(tmpdir(), "hb-upgrade-cleanup-"));
  const store = join(dir, "core.sqlite3");
  openCoreStore(store).close();
  if (previousSchema) {
    const db = new DatabaseSync(store);
    db.exec("ALTER TABLE flags DROP COLUMN error");
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION - 1));
    db.close();
  }
  const backups = `${store}.backups`;
  mkdirSync(backups, { recursive: true });
  return { dir, store, backups };
}

test("a directory named like a partial is skipped with its reason and the upgrade still runs", async () => {
  const lab = labStore(true);
  try {
    mkdirSync(join(lab.backups, PARTIAL));
    writeFileSync(join(lab.backups, ORPHAN), "x".repeat(4096));
    const reports: AbandonedBackupCleanup[] = [];
    const store = await openCoreStoreUpgrading(lab.store, {}, { abandonedPartials: (report) => reports.push(report) });
    store.close();
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0]!.removed, [{ name: ORPHAN, bytes: 4096 }]);
    assert.deepEqual(reports[0]!.skipped, [{ name: PARTIAL, reason: "not_a_file" }]);
    assert.ok(existsSync(join(lab.backups, PARTIAL)), "the directory is left alone");
    assert.equal(readdirSync(lab.backups).filter(name => name.endsWith(".json")).length, 1, "the upgrade backup was still published");
  } finally { rmSync(lab.dir, { recursive: true, force: true }); }
});

test("a partial that cannot be removed is skipped with the error and the store still opens", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, async () => {
  const lab = labStore(false);
  try {
    writeFileSync(join(lab.backups, ORPHAN), "x".repeat(2048));
    chmodSync(lab.backups, 0o500);
    const reports: AbandonedBackupCleanup[] = [];
    const store = await openCoreStoreUpgrading(lab.store, {}, { abandonedPartials: (report) => reports.push(report) });
    store.close();
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0]!.removed, []);
    assert.equal(reports[0]!.skipped.length, 1);
    assert.equal(reports[0]!.skipped[0]!.name, ORPHAN);
    assert.match(reports[0]!.skipped[0]!.reason, /^EACCES|^EPERM/);
    assert.ok(existsSync(join(lab.backups, ORPHAN)));
  } finally {
    chmodSync(lab.backups, 0o700);
    rmSync(lab.dir, { recursive: true, force: true });
  }
});
