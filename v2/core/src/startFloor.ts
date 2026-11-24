import { START_VOLUME_ROLES, type BeeFlagDetail, type FlagRow, type StartFloorDetail } from "./types.ts";

export const START_FLOOR_FLAG_PREFIX = "start_floor:";

export function describeStartFloor(detail: StartFloorDetail): string {
  return `${detail.path} has ${detail.free} free ${detail.metric} (floor ${detail.floor})`;
}

export function startFloorFlagDetail(detail: StartFloorDetail): string {
  const { role, path, metric, free, floor } = detail;
  return `${START_FLOOR_FLAG_PREFIX}${JSON.stringify({ role, path, metric, free, floor })}`;
}

export function startFloorOfFlagDetail(detail: string): StartFloorDetail | null {
  if (!detail.startsWith(START_FLOOR_FLAG_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(detail.slice(START_FLOOR_FLAG_PREFIX.length));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { role, path, metric, free, floor } = value as Record<string, unknown>;
  if (typeof role !== "string" || !(START_VOLUME_ROLES as readonly string[]).includes(role)) return null;
  if (typeof path !== "string" || (metric !== "bytes" && metric !== "inodes")) return null;
  if (typeof free !== "number" || typeof floor !== "number") return null;
  return { role: role as StartFloorDetail["role"], path, metric, free, floor };
}

export function renderFlagDetail(detail: string): string {
  const startFloor = startFloorOfFlagDetail(detail);
  return startFloor ? `start_floor: ${describeStartFloor(startFloor)}` : detail;
}

export function beeFlagDetail(row: FlagRow): BeeFlagDetail {
  const startFloor = startFloorOfFlagDetail(row.detail);
  return { flag: row.flag, detail: row.detail, setAt: row.setAt, resetsAt: row.resetsAt, ...(startFloor ? { startFloor } : {}) };
}
