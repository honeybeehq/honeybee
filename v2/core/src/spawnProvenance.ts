import type { SpawnProvenance } from "./types.ts";

export function parseSpawnProvenance(value: unknown): SpawnProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["callerBeeId", "authority", "peerPid", "serviceIntent"].includes(key)) || !Object.hasOwn(row, "callerBeeId") || !Object.hasOwn(row, "peerPid")) return null;
  if (row.authority !== "bee" && row.authority !== "registered_service" && row.authority !== "unattributed") return null;
  if (row.callerBeeId !== null && (typeof row.callerBeeId !== "string" || row.callerBeeId.length === 0 || Buffer.from(row.callerBeeId, "utf8").toString("utf8") !== row.callerBeeId || row.callerBeeId.includes("\0") || Buffer.byteLength(row.callerBeeId, "utf8") > 256)) return null;
  if (row.peerPid !== null && (typeof row.peerPid !== "number" || !Number.isSafeInteger(row.peerPid) || row.peerPid <= 0)) return null;
  if (row.serviceIntent !== undefined && row.serviceIntent !== "service" && row.serviceIntent !== "delegation") return null;
  if (row.authority === "bee" ? row.callerBeeId === null : row.callerBeeId !== null) return null;
  if (row.authority !== "registered_service" && row.serviceIntent !== undefined) return null;
  return { ...(row.serviceIntent === undefined ? {} : { serviceIntent: row.serviceIntent }), callerBeeId: row.callerBeeId, authority: row.authority, peerPid: row.peerPid };
}

export function readSpawnProvenance(value: unknown): SpawnProvenance | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return parseSpawnProvenance(parsed);
}
