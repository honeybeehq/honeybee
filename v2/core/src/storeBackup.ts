import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CoreError } from "./types.ts";

export class StoreBackupError extends CoreError {
  readonly code = "store_backup_failed";
}

export class StoreRestoreError extends CoreError {
  readonly code = "store_restore_refused";
}

export interface StoreBackupReceipt {
  format: 1;
  sourceBuild: string;
  storePath: string;
  schemaVersion: number;
  ddlDigest: string;
  integrityCheck: "ok";
  createdAt: string;
  sha256: string;
  backupPath: string;
  receiptPath: string;
}

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function sync(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function facts(db: DatabaseSync): { schemaVersion: number; ddlDigest: string; integrityCheck: "ok" } {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new StoreBackupError("Store integrity_check failed");
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta' AND type='table'").get();
  const version = hasMeta ? db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value : undefined;
  const schemaVersion = version === undefined ? 1 : Number(version);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new StoreBackupError("Invalid schema_version");
  const ddl = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
  return { schemaVersion, ddlDigest: digest(JSON.stringify(ddl)), integrityCheck: "ok" };
}

export function backupStore(db: DatabaseSync, storePath: string, sourceBuild: string): StoreBackupReceipt {
  let temporary: string | undefined;
  let receiptTemporary: string | undefined;
  let backupPath: string | undefined;
  let receiptPath: string | undefined;
  try {
    if (storePath === ":memory:") throw new StoreBackupError("An in-memory store has no durable backup");
    const directory = `${resolve(storePath)}.backups`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    sync(dirname(directory));
    const base = join(directory, `${Date.now()}-${randomUUID()}`);
    backupPath = `${base}.sqlite3`;
    temporary = `${base}.partial`;
    db.exec(`VACUUM INTO ${quote(temporary)}`);
    chmodSync(temporary, 0o600);
    const snapshot = new DatabaseSync(temporary, { readOnly: true });
    let verified: ReturnType<typeof facts>;
    try { verified = facts(snapshot); } finally { snapshot.close(); }
    sync(temporary);
    renameSync(temporary, backupPath);
    sync(directory);
    receiptPath = `${base}.json`;
    receiptTemporary = `${receiptPath}.partial`;
    const receipt: StoreBackupReceipt = { format: 1, sourceBuild, storePath: resolve(storePath), ...verified,
      createdAt: new Date().toISOString(), sha256: digest(readFileSync(backupPath)), backupPath, receiptPath };
    writeFileSync(`${receiptPath}.partial`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    sync(`${receiptPath}.partial`);
    renameSync(`${receiptPath}.partial`, receiptPath);
    sync(directory);
    prune(directory);
    return receipt;
  } catch (error) {
    for (const path of [temporary, receiptTemporary, receiptPath && !existsSync(receiptPath) ? backupPath : undefined]) {
      if (path && existsSync(path)) try { unlinkSync(path); } catch {}
    }
    if (error instanceof StoreBackupError) throw error;
    throw new StoreBackupError(`Backup refused: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function unlinkIfPresent(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function prune(directory: string): void {
  const receipts: Array<{ path: string; receipt: StoreBackupReceipt }> = [];
  for (const name of readdirSync(directory).filter(name => name.endsWith(".json"))) {
    const path = join(directory, name);
    try {
      const receipt = JSON.parse(readFileSync(path, "utf8")) as StoreBackupReceipt;
      if (receipt.format !== 1 || receipt.receiptPath !== path || receipt.backupPath !== path.replace(/\.json$/, ".sqlite3")
        || !Number.isSafeInteger(receipt.schemaVersion) || typeof receipt.createdAt !== "string") throw new Error("Foreign or moved receipt");
      receipts.push({ path, receipt });
    } catch {
      process.emitWarning(`Store backup retention skipped unrecognized receipt ${path}`);
    }
  }
  receipts.sort((a, b) => b.receipt.createdAt.localeCompare(a.receipt.createdAt) || b.path.localeCompare(a.path));
  const schemas = new Set<number>();
  for (const [index, item] of receipts.entries()) {
    const newest = !schemas.has(item.receipt.schemaVersion);
    schemas.add(item.receipt.schemaVersion);
    if (index < 10 || newest) continue;
    unlinkIfPresent(item.path);
    unlinkIfPresent(item.receipt.backupPath);
  }
  for (const name of readdirSync(directory)) {
    if (!/^\d+-[0-9a-f-]{36}\.(sqlite3|partial|json\.partial)$/.test(name)) continue;
    const base = name.replace(/\.(sqlite3|partial|json\.partial)$/, "");
    if (!existsSync(join(directory, `${base}.json`))) unlinkIfPresent(join(directory, name));
  }
  sync(directory);
}

export function backupStoreOffline(storePath: string, sourceBuild: string): StoreBackupReceipt {
  let db: DatabaseSync | undefined;
  try {
    if (!existsSync(storePath)) throw new StoreBackupError(`No store at ${storePath}`);
    db = new DatabaseSync(storePath);
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
    return backupStore(db, storePath, sourceBuild);
  } catch (error) {
    if (error instanceof StoreBackupError) throw error;
    throw new StoreBackupError(`Backup refused: ${error instanceof Error ? error.message : String(error)}`);
  } finally { db?.close(); }
}

function restoreStore(storePath: string, receiptPath: string): { preservedPath: string; schemaVersion: number; lossWindow: string } {
  const raw: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (!raw || typeof raw !== "object") throw new StoreBackupError("Invalid backup receipt");
  const receipt = raw as StoreBackupReceipt;
  if (receipt.format !== 1 || receipt.storePath !== resolve(storePath) || receipt.receiptPath !== resolve(receiptPath)
    || typeof receipt.backupPath !== "string" || dirname(receipt.backupPath) !== dirname(resolve(receiptPath))
    || typeof receipt.sha256 !== "string" || receipt.sha256 !== digest(readFileSync(receipt.backupPath))) throw new StoreBackupError("Backup receipt path or checksum mismatch");
  const snapshot = new DatabaseSync(receipt.backupPath, { readOnly: true });
  try {
    const checked = facts(snapshot);
    if (checked.schemaVersion !== receipt.schemaVersion || checked.ddlDigest !== receipt.ddlDigest || receipt.integrityCheck !== "ok") throw new StoreBackupError("Backup schema differs from receipt");
  } finally { snapshot.close(); }
  const db = new DatabaseSync(storePath);
  const preservedPath = `${storePath}.before-restore-${randomUUID()}`;
  const temporary = `${storePath}.restore-${randomUUID()}`;
  let replacement: DatabaseSync | undefined;
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
    if (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy !== 0) throw new StoreRestoreError("Store checkpoint is busy");
    if (db.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") throw new StoreRestoreError("Store could not leave WAL mode");
    copyFileSync(receipt.backupPath, temporary);
    chmodSync(temporary, 0o600);
    if (digest(readFileSync(temporary)) !== receipt.sha256) throw new StoreBackupError("Copied backup differs from receipt");
    sync(temporary);
    replacement = new DatabaseSync(temporary);
    if (replacement.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") throw new StoreRestoreError("Replacement must use DELETE journal mode");
    replacement.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
    const copied = facts(replacement);
    if (copied.schemaVersion !== receipt.schemaVersion || copied.ddlDigest !== receipt.ddlDigest) throw new StoreBackupError("Copied backup differs from receipt");
    linkSync(storePath, preservedPath);
    sync(dirname(resolve(storePath)));
    for (const suffix of ["-wal", "-shm"]) if (existsSync(`${storePath}${suffix}`)) renameSync(`${storePath}${suffix}`, `${preservedPath}${suffix}`);
    renameSync(temporary, storePath);
    sync(dirname(resolve(storePath)));
    return { preservedPath, schemaVersion: receipt.schemaVersion, lossWindow: "Writes made after the backup are discarded." };
  } finally {
    try { db.close(); } finally {
      try { replacement?.close(); } finally { unlinkIfPresent(temporary); }
    }
  }
}

export function restoreStoreOffline(storePath: string, receiptPath: string): { preservedPath: string; schemaVersion: number; lossWindow: string } {
  try { return restoreStore(storePath, resolve(receiptPath)); }
  catch (error) { throw new StoreRestoreError(`Restore refused: ${error instanceof Error ? error.message : String(error)}`); }
}
