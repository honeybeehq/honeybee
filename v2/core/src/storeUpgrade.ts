import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./schema.ts";
import { CoreStore, storeSourceBuild, type CoreStoreOptions } from "./store.ts";
import { backupStoreOnline, pruneStoreBackups, removeAbandonedBackupPartials, verifyStoreBackupFile, type AbandonedBackupCleanup, type StoreBackupRetention, type StoreBackupVerification } from "./storeBackup.ts";

export type { AbandonedBackupCleanup, StoreBackupRetention } from "./storeBackup.ts";
import { SecondWriterError } from "./types.ts";

export type StoreUpgradePhase = "store_backup" | "store_backup_verify" | "store_migrate";

export interface StoreSchemaUpgrade {
  schemaFrom: number;
  schemaTo: number;
}

export interface StoreUpgradeProgress extends StoreSchemaUpgrade {
  phase: StoreUpgradePhase;
  bytesDone: number | null;
  bytesTotal: number | null;
}

export interface StoreUpgradeHooks {
  locked?: (upgrade: StoreSchemaUpgrade | null) => Promise<void> | void;
  abandonedPartials?: (cleanup: AbandonedBackupCleanup) => void;
  backupRetention?: (retention: StoreBackupRetention) => void;
  progress?: (progress: StoreUpgradeProgress) => void;
  verify?: (path: string) => Promise<StoreBackupVerification>;
  signal?: AbortSignal;
}

function storedSchemaValue(db: DatabaseSync, key: string): number | null | "invalid" {
  const value = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : "invalid";
}

function pendingSchemaUpgrade(db: DatabaseSync, path: string): StoreSchemaUpgrade | null {
  if (path === ":memory:") return null;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) return null;
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta' AND type='table'").get();
  const stored = hasMeta ? storedSchemaValue(db, "schema_version") : null;
  const minReader = hasMeta ? storedSchemaValue(db, "min_reader_schema") : null;
  if (stored === "invalid" || minReader === "invalid") return null;
  const schemaFrom = stored ?? 1;
  if ((minReader ?? schemaFrom) > SCHEMA_VERSION || schemaFrom >= SCHEMA_VERSION) return null;
  return { schemaFrom, schemaTo: SCHEMA_VERSION };
}

export async function openCoreStoreUpgrading(path: string, opts: CoreStoreOptions = {}, hooks: StoreUpgradeHooks = {}): Promise<CoreStore> {
  const db = new DatabaseSync(path);
  let handedOver = false;
  try {
    try { db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; BEGIN EXCLUSIVE; COMMIT"); }
    catch (error) { throw new SecondWriterError(path, error); }
    const cleanup = removeAbandonedBackupPartials(path);
    if (cleanup.removed.length || cleanup.skipped.length) hooks.abandonedPartials?.(cleanup);
    hooks.backupRetention?.(pruneStoreBackups(path));
    const upgrade = pendingSchemaUpgrade(db, path);
    await hooks.locked?.(upgrade);
    hooks.signal?.throwIfAborted();
    if (upgrade) {
      const report = (phase: StoreUpgradePhase, bytesDone: number | null = null, bytesTotal: number | null = null) => hooks.progress?.({ ...upgrade, phase, bytesDone, bytesTotal });
      const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
      report("store_backup", 0, Number(db.prepare("PRAGMA page_count").get()?.page_count) * pageSize);
      const published = await backupStoreOnline(db, path, storeSourceBuild(db), {
        ...(hooks.signal ? { signal: hooks.signal } : {}),
        progress: ({ totalPages, remainingPages }) => report("store_backup", (totalPages - remainingPages) * pageSize, totalPages * pageSize),
        verify: async (copy) => {
          report("store_backup_verify");
          return (hooks.verify ?? (async (file: string) => verifyStoreBackupFile(file)))(copy);
        },
      });
      hooks.backupRetention?.(published.retention);
      hooks.signal?.throwIfAborted();
      report("store_migrate");
    }
    handedOver = true;
    return new CoreStore(path, { ...opts, connection: db, upgradeBackupTaken: upgrade !== null });
  } finally {
    if (!handedOver) db.close();
  }
}
