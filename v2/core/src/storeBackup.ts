import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, lstatSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

export type StoreBackupResult = StoreBackupReceipt & { retention: StoreBackupRetention };

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

function publishBackup(target: BackupTarget, storePath: string, sourceBuild: string, verified: StoreBackupVerification): StoreBackupResult {
  renameSync(target.temporary, target.backupPath);
  sync(target.directory);
  const receipt: StoreBackupReceipt = { format: 1, sourceBuild, storePath: resolve(storePath), schemaVersion: verified.schemaVersion, ddlDigest: verified.ddlDigest,
    integrityCheck: verified.integrityCheck, createdAt: new Date().toISOString(), sha256: verified.sha256, backupPath: target.backupPath, receiptPath: target.receiptPath };
  writeFileSync(`${target.receiptPath}.partial`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  sync(`${target.receiptPath}.partial`);
  renameSync(`${target.receiptPath}.partial`, target.receiptPath);
  sync(target.directory);
  return { ...receipt, retention: pruneStoreBackups(storePath) };
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

export function backupStore(db: DatabaseSync, storePath: string, sourceBuild: string): StoreBackupResult {
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
  progress?: (pages: { totalPages: number; remainingPages: number }) => void;
  signal?: AbortSignal;
}

async function copyStoreOnline(db: DatabaseSync, temporary: string, restarts: () => number, options: OnlineBackupOptions): Promise<void> {
  let steps = 0;
  let flush: Promise<void> | null = null;
  let fd: number | undefined;
  try {
    await backup(db, temporary, {
      rate: ONLINE_BACKUP_STEP_PAGES,
      progress: (pages) => {
        options.signal?.throwIfAborted();
        if (restarts() > ONLINE_BACKUP_MAX_RESTARTS) throw new OnlineBackupRestarted();
        options.progress?.(pages);
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

export async function backupStoreOnline(db: DatabaseSync, storePath: string, sourceBuild: string, options: OnlineBackupOptions = {}): Promise<StoreBackupResult> {
  let target: BackupTarget | undefined;
  try {
    target = backupTarget(storePath);
    try { await copyStoreOnline(db, target.temporary, options.restarts ?? (() => 0), options); }
    catch (error) {
      if (!(error instanceof OnlineBackupRestarted)) throw error;
      discardBackup(target);
      options.blocking?.(`write transactions rolled back ${ONLINE_BACKUP_MAX_RESTARTS + 1} times during the copy`);
      return backupStore(db, storePath, sourceBuild);
    }
    chmodSync(target.temporary, 0o600);
    const verified = await (options.verify ?? (async (path: string) => verifyStoreBackupFile(path)))(target.temporary);
    options.signal?.throwIfAborted();
    return publishBackup(target, storePath, sourceBuild, verified);
  } catch (error) {
    discardBackup(target);
    throw refusedBackup(error);
  }
}

export interface AbandonedBackupPartial {
  name: string;
  bytes: number;
}

export interface SkippedBackupPartial {
  name: string;
  reason: string;
}

export interface AbandonedBackupCleanup {
  removed: AbandonedBackupPartial[];
  skipped: SkippedBackupPartial[];
}

const ABANDONED_PARTIAL = /^\d+-[0-9a-f-]{36}\.(json\.)?partial(-journal|-wal|-shm)?$/;

function failureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code ?? (error instanceof Error ? error.message : String(error));
}

export function removeAbandonedBackupPartials(storePath: string): AbandonedBackupCleanup {
  const cleanup: AbandonedBackupCleanup = { removed: [], skipped: [] };
  if (storePath === ":memory:") return cleanup;
  const directory = `${resolve(storePath)}.backups`;
  let names: string[];
  try { names = readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanup.skipped.push({ name: ".", reason: failureReason(error) });
    return cleanup;
  }
  for (const name of names) {
    if (!ABANDONED_PARTIAL.test(name)) continue;
    const path = join(directory, name);
    try {
      const entry = lstatSync(path);
      if (!entry.isFile()) {
        cleanup.skipped.push({ name, reason: "not_a_file" });
        continue;
      }
      unlinkSync(path);
      cleanup.removed.push({ name, bytes: entry.size });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      cleanup.skipped.push({ name, reason: failureReason(error) });
    }
  }
  if (cleanup.removed.length) {
    try { sync(directory); } catch {}
  }
  return cleanup;
}

function unlinkIfPresent(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export const STORE_BACKUPS_KEPT = 2;

export interface KeptStoreBackup {
  name: string;
  createdAt: string;
  bytes: number;
}

export interface RemovedStoreBackup {
  name: string;
  bytes: number;
  kind: "older_backup" | "orphan_copy" | "dangling_receipt";
}

export interface StoreBackupRetention {
  kept: KeptStoreBackup[];
  removed: RemovedStoreBackup[];
  skipped: SkippedBackupPartial[];
}

const BACKUP_FILE = /^(\d+-[0-9a-f-]{36})\.(sqlite3|json)$/;

function recognizedReceipt(path: string): StoreBackupReceipt | null {
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8")) as StoreBackupReceipt;
    const recognized = receipt.format === 1 && receipt.receiptPath === path && receipt.backupPath === path.replace(/\.json$/, ".sqlite3")
      && Number.isSafeInteger(receipt.schemaVersion) && typeof receipt.createdAt === "string";
    return recognized ? receipt : null;
  } catch { return null; }
}

function regularFileBytes(path: string): number | "missing" | "not_a_file" {
  try {
    const entry = lstatSync(path);
    return entry.isFile() ? entry.size : "not_a_file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export function pruneStoreBackups(storePath: string): StoreBackupRetention {
  const retention: StoreBackupRetention = { kept: [], removed: [], skipped: [] };
  if (storePath === ":memory:") return retention;
  const directory = `${resolve(storePath)}.backups`;
  let names: string[];
  try { names = readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") retention.skipped.push({ name: ".", reason: failureReason(error) });
    return retention;
  }
  const present = new Set(names);
  const completed: Array<{ base: string; createdAt: string; bytes: number }> = [];
  const remove = (base: string, files: string[], bytes: number, kind: RemovedStoreBackup["kind"]) => {
    for (const name of files) {
      try { unlinkSync(join(directory, name)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        retention.skipped.push({ name, reason: failureReason(error) });
        return;
      }
    }
    retention.removed.push({ name: `${base}.sqlite3`, bytes, kind });
  };
  for (const name of names) {
    const match = BACKUP_FILE.exec(name);
    if (!match) continue;
    const [, base, extension] = match as unknown as [string, string, "sqlite3" | "json"];
    try {
      if (extension === "sqlite3") {
        if (present.has(`${base}.json`)) continue;
        const bytes = regularFileBytes(join(directory, name));
        if (bytes === "not_a_file") retention.skipped.push({ name, reason: "not_a_file" });
        else if (bytes !== "missing") remove(base, [name], bytes, "orphan_copy");
        continue;
      }
      const receiptBytes = regularFileBytes(join(directory, name));
      if (receiptBytes === "missing") continue;
      if (receiptBytes === "not_a_file") { retention.skipped.push({ name, reason: "not_a_file" }); continue; }
      const receipt = recognizedReceipt(join(directory, name));
      if (!receipt) { retention.skipped.push({ name, reason: "unrecognized_receipt" }); continue; }
      const copyBytes = regularFileBytes(receipt.backupPath);
      if (copyBytes === "not_a_file") retention.skipped.push({ name: `${base}.sqlite3`, reason: "not_a_file" });
      else if (copyBytes === "missing") remove(base, [name], receiptBytes, "dangling_receipt");
      else completed.push({ base, createdAt: receipt.createdAt, bytes: copyBytes + receiptBytes });
    } catch (error) {
      retention.skipped.push({ name, reason: failureReason(error) });
    }
  }
  completed.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.base.localeCompare(a.base));
  for (const [index, backup] of completed.entries()) {
    if (index < STORE_BACKUPS_KEPT) retention.kept.push({ name: `${backup.base}.sqlite3`, createdAt: backup.createdAt, bytes: backup.bytes });
    else remove(backup.base, [`${backup.base}.sqlite3`, `${backup.base}.json`], backup.bytes, "older_backup");
  }
  if (retention.removed.length) {
    try { sync(directory); } catch {}
  }
  return retention;
}

function readableBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

export function describeBackupRetention(retention: StoreBackupRetention): string {
  const newest = retention.kept[0];
  const kept = `kept ${retention.kept.length} backup${retention.kept.length === 1 ? "" : "s"}${newest ? ` (newest ${newest.createdAt})` : ""}`;
  const removedBytes = retention.removed.reduce((total, entry) => total + entry.bytes, 0);
  const removed = `removed ${retention.removed.length} older (${readableBytes(removedBytes)})`;
  const skipped = retention.skipped.length ? `; could not remove ${retention.skipped.map(entry => `${entry.name} (${entry.reason})`).join(", ")}` : "";
  return `${kept}; ${removed}${skipped}`;
}

export function backupStoreOffline(storePath: string, sourceBuild: string): StoreBackupResult {
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
