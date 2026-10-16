import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ENDPOINT_RECORD_FILE = "hived.endpoint.json";

export interface EndpointRecord {
  schema: 1;
  instanceId: string;
  dataDir: string;
  socketPath: string;
  tmuxSocketPath?: string;
  pid: number;
  startedAt: number;
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

export function writeEndpointRecord(dataDir: string, record: Omit<EndpointRecord, "schema">): void {
  const path = join(dataDir, ENDPOINT_RECORD_FILE);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ schema: 1, ...record })}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function removeEndpointRecord(dataDir: string, instanceId: string): void {
  const path = join(dataDir, ENDPOINT_RECORD_FILE);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { instanceId?: unknown };
    if (raw.instanceId === instanceId) rmSync(path, { force: true });
  } catch {
    return;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLiveEndpointRecord(dataDir: string, alive: (pid: number) => boolean = pidAlive): EndpointRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dataDir, ENDPOINT_RECORD_FILE), "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1 || typeof r.instanceId !== "string" || typeof r.dataDir !== "string" || typeof r.socketPath !== "string"
    || typeof r.pid !== "number" || !Number.isSafeInteger(r.pid) || r.pid <= 0 || typeof r.startedAt !== "number") return null;
  if (!alive(r.pid)) return null;
  return {
    schema: 1,
    instanceId: r.instanceId,
    dataDir: r.dataDir,
    socketPath: r.socketPath,
    ...(typeof r.tmuxSocketPath === "string" ? { tmuxSocketPath: r.tmuxSocketPath } : {}),
    pid: r.pid,
    startedAt: r.startedAt,
  };
}
