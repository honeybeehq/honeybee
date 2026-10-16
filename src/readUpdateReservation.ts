import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readLiveUpdateOwner } from "./v2/updateOwnerClient.mjs";
import { parseDurableUpdateReservation, isApiarySwap, type DurableUpdateReservation } from "./apiarySwap.js";

function parseOwnerReservation(value: unknown): DurableUpdateReservation | null {
  if (value === null) return null;
  if (typeof value === "object" && value !== null && "epoch" in value && value.epoch === 0
    && "id" in value && value.id === "" && "recoverySubjectDigest" in value && value.recoverySubjectDigest === ""
    && "active" in value && value.active === false) return null;
  return parseDurableUpdateReservation(value);
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

export async function readUpdateReservation(root: string): Promise<DurableUpdateReservation | null> {
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
    return row ? parseDurableUpdateReservation(JSON.parse(String(row.value))) : null;
  } finally { db.close(); }
}

export class DeployReservationHeldError extends Error {
  readonly code = "DEPLOY_RESERVATION_HELD";
  constructor(readonly reservationId: string, readonly epoch: number, readonly purpose: "paired-recovery" | "apiary-swap" = "paired-recovery") {
    super(`deploy: ${purpose} update reservation ${reservationId} at epoch ${epoch} is held; finish or recover the coordinated update, then clear it with hive update-owner ${purpose === "apiary-swap" ? "apiary-swap release" : "release"} using its exact owner tuple and completion receipt`);
    this.name = "DeployReservationHeldError";
  }
}

export async function assertRuntimeUpdateAllowed(root: string, operation: "deploy" | "rollback" | "restart" | "artifact" | "prune" = "deploy"): Promise<void> {
  const reservation = await readUpdateReservation(root);
  if (reservation?.active && (isApiarySwap(reservation) || !["artifact", "prune"].includes(operation))) {
    throw new DeployReservationHeldError(reservation.id, reservation.epoch, isApiarySwap(reservation) ? "apiary-swap" : "paired-recovery");
  }
}
