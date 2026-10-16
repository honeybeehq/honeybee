import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseUpdateReservation, type UpdateReservation } from "./updateReservation.js";
import { readLiveUpdateOwner } from "./v2/updateOwnerClient.mjs";

function parseOwnerReservation(value: unknown): UpdateReservation | null {
  if (value === null) return null;
  if (typeof value === "object" && value !== null && "epoch" in value && value.epoch === 0
    && "id" in value && value.id === "" && "recoverySubjectDigest" in value && value.recoverySubjectDigest === ""
    && "active" in value && value.active === false) return null;
  return parseUpdateReservation(value);
}

function existsOrThrow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readUpdateReservation(root: string): Promise<UpdateReservation | null> {
  const dataDir = resolve(root, "..", "v2");
  const storePath = join(dataDir, "core.sqlite3");
  const socketPath = join(dataDir, "hived.sock");
  const configPath = join(dataDir, "config.json");
  if (existsOrThrow(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)
      || (config.storePath !== undefined && config.storePath !== storePath)
      || (config.socketPath !== undefined && config.socketPath !== socketPath)) {
      throw new Error("deploy: cannot read update reservation from custom storage/socket");
    }
  }
  if (!existsOrThrow(storePath)) return null;
  const response = await readLiveUpdateOwner(socketPath, dataDir);
  if (response.kind === "live") {
    const live = response.owner;
    if (!live || typeof live !== "object" || Array.isArray(live)
      || !("runtimeRoot" in live) || typeof live.runtimeRoot !== "string" || resolve(live.runtimeRoot) !== resolve(root)
      || !("storePath" in live) || typeof live.storePath !== "string" || resolve(live.storePath) !== storePath
      || !("reservation" in live)) {
      throw new Error("deploy: cannot identify update reservation owner");
    }
    return parseOwnerReservation(live.reservation);
  }
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='coordinated_update'").get();
    return row ? parseUpdateReservation(JSON.parse(String(row.value))) : null;
  } finally { db.close(); }
}
