import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function recordedSocketPath(dataDir: string): string {
  const fallback = join(dataDir, "hived.sock");
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(join(dataDir, "hived.endpoint.json"), "utf8"));
  } catch {
    return fallback;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return fallback;
  const value = record as Record<string, unknown>;
  if (value.schema !== 1 || typeof value.socketPath !== "string" || typeof value.dataDir !== "string"
    || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return fallback;
  if (canonical(value.dataDir) !== canonical(dataDir) || !processAlive(value.pid)) return fallback;
  return value.socketPath;
}

