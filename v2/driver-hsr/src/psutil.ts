import {inspectProcess, sameProcess, type ProcessIdentity, type ProcessInspection} from "../../harness/src/processIdentity.ts";
import {processIdentityValue} from "../../core/src/processIdentity.ts";
export {inspectProcess, sameProcess};
export type {ProcessIdentity, ProcessInspection};
export class ProcessIdentityUnavailableError extends Error {
  readonly code = "process_identity_unresolved";
  constructor() { super("stop pending process identity proof"); }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const value = inspectProcess(pid);
  return value.kind === "unavailable" || value.kind === "present" && value.state === "live";
}

export function processDisposition(identity: ProcessIdentity | null, value: ProcessInspection): "live" | "exited" | "unavailable" {
  if (!identity || value.kind === "unavailable") return "unavailable";
  if (value.kind === "gone") return "exited";
  if (!sameProcess(identity, value)) return "unavailable";
  return value.state === "zombie" ? "exited" : "live";
}

export function zombieWaitStatus(pid: number, identity: ProcessIdentity | null): number | null {
  const value = inspectProcess(pid);
  return identity && sameProcess(identity, value) && value.state === "zombie" ? value.waitStatus : null;
}

export function parseEtimeMs(etime: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const days = Number(m[1] ?? "0");
  const hours = Number(m[2] ?? "0");
  const minutes = Number(m[3] ?? "0");
  const seconds = Number(m[4] ?? "0");
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}


export function processStartTimeMs(pid: number, _now: () => number = Date.now): number | null {
  const value = inspectProcess(pid);
  return value.kind === "present" ? value.startedAtMs : null;
}

export function legacyProcessCandidate(pid: number, stamp: number, value: ProcessInspection = inspectProcess(pid)): Extract<ProcessInspection, {kind: "present"}> | null {
  return value.kind === "present" && value.pid === pid && value.state === "live" && Number.isFinite(stamp) && Math.abs(value.startedAtMs - stamp) <= 5000 ? value : null;
}

export function verifyProcessIdentity(pid: number, identity: ProcessIdentity | null): boolean {
  const value = inspectProcess(pid);
  const expected = processIdentityValue(identity);
  return expected !== null && expected.pid === pid && sameProcess(expected, value) && value.state === "live";
}
