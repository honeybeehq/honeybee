import type {DatabaseSync} from "node:sqlite";

export interface TmuxCleanupLocator {
  beeId: string;
  generation: number;
  reason: "ownership-unverified";
  paneId: string | null;
  sessionId: string | null;
  windowId: string | null;
  socket: {dev: number; ino: number; parentDev: number; parentIno: number} | null;
}
export type TmuxCleanupState = "retained" | "socket-gone-unverifiable";
export interface TmuxCleanupEntry extends TmuxCleanupLocator {state: TmuxCleanupState}
export interface TmuxCleanupHooks {
  entries(): TmuxCleanupEntry[];
  update(locator: TmuxCleanupLocator, state: TmuxCleanupState | "resolved"): void;
}
export const TMUX_CLEANUP_KINDS = "'runtime.tmux_cleanup_retained','runtime.tmux_cleanup_unverifiable','runtime.tmux_cleanup_resolved'";
export function cleanupLocator(value: unknown): TmuxCleanupLocator | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "beeId,generation,paneId,reason,sessionId,socket,windowId" || typeof v.beeId !== "string" || !v.beeId || !Number.isSafeInteger(v.generation) || Number(v.generation) < 1 || v.reason !== "ownership-unverified" || (v.paneId !== null && (typeof v.paneId !== "string" || !/^%[0-9]+$/.test(v.paneId))) || (v.sessionId !== null && (typeof v.sessionId !== "string" || !/^\$[0-9]+$/.test(v.sessionId))) || (v.windowId !== null && (typeof v.windowId !== "string" || !/^@[0-9]+$/.test(v.windowId))) || (v.socket !== null && (typeof v.socket !== "object" || Array.isArray(v.socket)))) return null;
  const socket = v.socket as Record<string, unknown>;
  if (socket !== null && (Object.keys(socket).sort().join(",") !== "dev,ino,parentDev,parentIno" || !Object.values(socket).every(Number.isSafeInteger) || Number(socket.ino) < 0 || Number(socket.parentIno) < 0)) return null;
  return {beeId: v.beeId, generation: Number(v.generation), reason: v.reason, paneId: v.paneId as string | null, sessionId: v.sessionId as string | null, windowId: v.windowId as string | null, socket: socket === null ? null : {dev: Number(socket.dev), ino: Number(socket.ino), parentDev: Number(socket.parentDev), parentIno: Number(socket.parentIno)}};
}
export function readTmuxCleanup(db: DatabaseSync): {entries: TmuxCleanupEntry[]; malformed: number} {
  const pending = new Map<string, TmuxCleanupEntry>();
  let malformed = 0;
  for (const row of db.prepare(`SELECT bee_id,payload,kind FROM audit WHERE kind IN (${TMUX_CLEANUP_KINDS}) ORDER BY seq`).all()) {
    try {
      const p = JSON.parse(String(row.payload)) as Record<string, unknown>;
      if (!p || typeof p !== "object" || Array.isArray(p) || !Number.isSafeInteger(p.generation) || Number(p.generation) < 1 || p.count !== 1 || typeof row.bee_id !== "string") throw new Error("invalid cleanup report");
      const key = `${row.bee_id}:${p.generation}`;
      if (row.kind === "runtime.tmux_cleanup_resolved") {
        if (Object.keys(p).sort().join(",") !== "count,generation,reason" || p.reason !== "ownership-unverified") throw new Error("invalid cleanup resolution");
        if (pending.has(key)) pending.delete(key);
        continue;
      }
      const info = row.kind === "runtime.tmux_cleanup_unverifiable";
      if (Object.keys(p).sort().join(",") !== (info ? "count,generation,locator,reason,retainedReason" : "count,generation,locator,reason") || p.reason !== (info ? "socket-gone-unverifiable" : "ownership-unverified") || info && p.retainedReason !== "ownership-unverified") throw new Error("invalid cleanup state");
      const locator = cleanupLocator(p.locator);
      if (!locator || locator.beeId !== row.bee_id || locator.generation !== p.generation) throw new Error("invalid cleanup locator");
      if (info && !pending.has(key)) throw new Error("unmatched cleanup state");
      pending.set(key, {...locator, state: info ? "socket-gone-unverifiable" : "retained"});
    } catch {malformed++;}
  }
  return {entries: [...pending.values()], malformed};
}
