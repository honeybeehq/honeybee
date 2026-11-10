import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { SecondWriterError } from "./types.ts";

export interface StoreWriterLock {
  release(): void;
}

export function storeWriterLockPath(storePath: string): string {
  return `${storePath}.writer-lock`;
}

export function acquireStoreWriterLock(storePath: string): StoreWriterLock {
  const lock = new DatabaseSync(storeWriterLockPath(storePath));
  try {
    lock.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE");
    lock.exec("PRAGMA busy_timeout = 2000");
    lock.exec("CREATE TABLE IF NOT EXISTS holder(id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL) STRICT");
    lock.prepare("INSERT INTO holder(id, pid, acquired_at) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, acquired_at = excluded.acquired_at").run(process.pid, Date.now());
    lock.exec("COMMIT");
  } catch (error) {
    try { lock.close(); } catch {}
    throw new SecondWriterError(storePath, error);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      lock.close();
    },
  };
}

export function storeWriterLockHeld(storePath: string): boolean {
  const path = storeWriterLockPath(storePath);
  if (!existsSync(path)) return false;
  const probe = new DatabaseSync(path, { readOnly: true });
  try {
    probe.exec("PRAGMA busy_timeout = 0");
    probe.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return false;
  } catch (error) {
    if (error instanceof Error && /locked|busy/i.test(error.message)) return true;
    throw error;
  } finally {
    probe.close();
  }
}
