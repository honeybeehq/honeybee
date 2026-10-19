import type {DatabaseSync} from "node:sqlite";

import {processIdentityValue, type RuntimeProcessIdentity} from "./processIdentity.ts";
export {processIdentityValue};
export type {RuntimeProcessIdentity};
export type RuntimeIdentityRead = {kind: "bound"; identity: RuntimeProcessIdentity; pidStartedAt: number} | {kind: "legacy"} | {kind: "unavailable"};
export interface RuntimeIdentityHooks {
  read(beeId: string, generation: number): RuntimeIdentityRead;
  unavailable?(beeId: string, generation: number): void;
  bindLegacy(beeId: string, generation: number, stamp: number, identity: RuntimeProcessIdentity, proof: "authenticated-host-generation" | "owned-tmux-pane"): boolean;
}
export function installRuntimeProcessIdentity(db: DatabaseSync): void {
  if (!db.prepare("PRAGMA table_info(runtimes)").all().some(row => row.name === "process_identity")) db.exec("ALTER TABLE runtimes ADD COLUMN process_identity TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS audit_tmux_cleanup ON audit(seq) WHERE kind IN ('runtime.tmux_cleanup_retained','runtime.tmux_cleanup_unverifiable','runtime.tmux_cleanup_resolved')");
  db.prepare("INSERT INTO meta(key,value) VALUES('runtime_process_identity_schema','1') ON CONFLICT(key) DO NOTHING").run();
}
export function readRuntimeProcessIdentity(db: DatabaseSync, beeId: string, generation: number): RuntimeIdentityRead {
  if (db.prepare("SELECT value FROM meta WHERE key='runtime_process_identity_schema'").get()?.value !== "1") return {kind: "unavailable"};
  const row = db.prepare("SELECT pid,pid_started_at,process_identity FROM runtimes WHERE bee_id=? AND generation=?").get(beeId, generation);
  if (!row) return {kind: "unavailable"};
  if (row.process_identity === null) return {kind: "legacy"};
  try {
    const identity = processIdentityValue(JSON.parse(String(row.process_identity)));
    return identity && identity.pid === row.pid && typeof row.pid_started_at === "number" && Number.isFinite(row.pid_started_at) ? {kind: "bound", identity, pidStartedAt: row.pid_started_at} : {kind: "unavailable"};
  } catch { return {kind: "unavailable"}; }
}
