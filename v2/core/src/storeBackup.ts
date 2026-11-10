import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
const FILE_DIGEST_CHUNK_BYTES = 1024 * 1024;
function fileDigest(path: string): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(FILE_DIGEST_CHUNK_BYTES);
  const fd = openSync(path, "r");
  try {
    for (let read = readSync(fd, chunk, 0, chunk.length, null); read > 0; read = readSync(fd, chunk, 0, chunk.length, null)) hash.update(chunk.subarray(0, read));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}
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

export type StoreBackupVerification = ReturnType<typeof facts> & { sha256: string };

interface BackupTarget {
  directory: string;
  backupPath: string;
  temporary: string;
  receiptPath: string;
}

function backupTarget(storePath: string): BackupTarget {
  if (storePath === ":memory:") throw new StoreBackupError("An in-memory store has no durable backup");
  const directory = `${resolve(storePath)}.backups`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  sync(dirname(directory));
  const base = join(directory, `${Date.now()}-${randomUUID()}`);
  return { directory, backupPath: `${base}.sqlite3`, temporary: `${base}.partial`, receiptPath: `${base}.json` };
}

function publishBackup(target: BackupTarget, storePath: string, sourceBuild: string, verified: StoreBackupVerification): StoreBackupReceipt {
  renameSync(target.temporary, target.backupPath);
  sync(target.directory);
  const receipt: StoreBackupReceipt = { format: 1, sourceBuild, storePath: resolve(storePath), schemaVersion: verified.schemaVersion, ddlDigest: verified.ddlDigest,
    integrityCheck: verified.integrityCheck, createdAt: new Date().toISOString(), sha256: verified.sha256, backupPath: target.backupPath, receiptPath: target.receiptPath };
  writeFileSync(`${target.receiptPath}.partial`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  sync(`${target.receiptPath}.partial`);
  renameSync(`${target.receiptPath}.partial`, target.receiptPath);
  sync(target.directory);
  prune(target.directory);
  return receipt;
}

function discardBackup(target: BackupTarget | undefined): void {
  if (!target) return;
  for (const path of [target.temporary, `${target.receiptPath}.partial`, existsSync(target.receiptPath) ? undefined : target.backupPath]) {
    if (path && existsSync(path)) try { unlinkSync(path); } catch {}
  }
}

function refusedBackup(error: unknown): StoreBackupError {
  return error instanceof StoreBackupError ? error : new StoreBackupError(`Backup refused: ${error instanceof Error ? error.message : String(error)}`);
}

export function backupStore(db: DatabaseSync, storePath: string, sourceBuild: string): StoreBackupReceipt {
  let target: BackupTarget | undefined;
  try {
    target = backupTarget(storePath);
    db.exec(`VACUUM INTO ${quote(target.temporary)}`);
    chmodSync(target.temporary, 0o600);
    const snapshot = new DatabaseSync(target.temporary, { readOnly: true });
    let verified: ReturnType<typeof facts>;
    try { verified = facts(snapshot); } finally { snapshot.close(); }
    sync(target.temporary);
    return publishBackup(target, storePath, sourceBuild, { ...verified, sha256: fileDigest(target.temporary) });
  } catch (error) {
    discardBackup(target);
    throw refusedBackup(error);
  }
}

export function verifyStoreBackupFile(path: string): StoreBackupVerification {
  const snapshot = new DatabaseSync(path);
  let verified: ReturnType<typeof facts>;
  try {
    if (snapshot.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") throw new StoreBackupError("Backup snapshot could not leave WAL mode");
    verified = facts(snapshot);
  } finally { snapshot.close(); }
  sync(path);
  return { ...verified, sha256: fileDigest(path) };
}

export const ONLINE_BACKUP_STEP_PAGES = 64;
export const ONLINE_BACKUP_SYNC_EVERY_STEPS = 32;
export const ONLINE_BACKUP_MAX_RESTARTS = 3;

class OnlineBackupRestarted extends Error {}

export interface OnlineBackupOptions {
  verify?: (path: string) => Promise<StoreBackupVerification>;
  blocking?: (reason: string) => void;
  restarts?: () => number;
}

async function copyStoreOnline(db: DatabaseSync, temporary: string, restarts: () => number): Promise<void> {
  let steps = 0;
  let flush: Promise<void> | null = null;
  let fd: number | undefined;
  try {
    await backup(db, temporary, {
      rate: ONLINE_BACKUP_STEP_PAGES,
      progress: () => {
        if (restarts() > ONLINE_BACKUP_MAX_RESTARTS) throw new OnlineBackupRestarted();
        if (++steps % ONLINE_BACKUP_SYNC_EVERY_STEPS !== 0 || flush) return;
        const open = fd ??= openSync(temporary, "r");
        flush = new Promise<void>((done) => fsync(open, () => { flush = null; done(); }));
      },
    });
  } finally {
    if (flush) await flush;
    if (fd !== undefined) closeSync(fd);
  }
}

export async function backupStoreOnline(db: DatabaseSync, storePath: string, sourceBuild: string, options: OnlineBackupOptions = {}): Promise<StoreBackupReceipt> {
  let target: BackupTarget | undefined;
  try {
    target = backupTarget(storePath);
    try { await copyStoreOnline(db, target.temporary, options.restarts ?? (() => 0)); }
    catch (error) {
      if (!(error instanceof OnlineBackupRestarted)) throw error;
      discardBackup(target);
      options.blocking?.(`write transactions rolled back ${ONLINE_BACKUP_MAX_RESTARTS + 1} times during the copy`);
      return backupStore(db, storePath, sourceBuild);
    }
    chmodSync(target.temporary, 0o600);
    const verified = await (options.verify ?? (async (path: string) => verifyStoreBackupFile(path)))(target.temporary);
    return publishBackup(target, storePath, sourceBuild, verified);
  } catch (error) {
    discardBackup(target);
    throw refusedBackup(error);
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
    || typeof receipt.sha256 !== "string" || receipt.sha256 !== fileDigest(receipt.backupPath)) throw new StoreBackupError("Backup receipt path or checksum mismatch");
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
    if (fileDigest(temporary) !== receipt.sha256) throw new StoreBackupError("Copied backup differs from receipt");
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
