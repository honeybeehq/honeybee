import { assertPeercredReceipt } from "../../../src/peercredReceipt.ts";
import { createHash } from "node:crypto";
import { closeSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {processIdentityValue} from "../../core/src/processIdentity.ts";

export function validatePeerArtifact(directory: string, target: string): string {
  if (!["linux-x64", "linux-arm64", "darwin-arm64"].includes(target)) throw new Error("Unsupported peer credential target");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const binary = join(directory, "peercred.node");
  const bytes = readFileSync(binary);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (manifest.version !== 1 || manifest.target !== target || manifest.napi !== 8 || manifest.sha256 !== hash) throw new Error("Invalid peer credential artifact metadata");
  const recordPath = join(directory, "..", "..", "..", ".build-repack.json");
  if (existsSync(recordPath)) {
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assertPeercredReceipt(record.peercred, record.sourceHead, target, hash);
  }
  const [platform, architecture] = target.split("-");
  if (platform === "linux") {
    if (bytes.length < 64 || bytes.toString("hex", 0, 4) !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== (architecture === "x64" ? 62 : 183)) throw new Error("Wrong peer credential ELF target");
  } else if (platform === "darwin") {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (architecture === "x64" ? 0x01000007 : 0x0100000c) || bytes.readUInt32LE(12) !== 8) throw new Error("Wrong peer credential Mach-O target");
  } else throw new Error("Unsupported peer credential target");
  return binary;
}

export interface ProcessIdentity { pid: number; birth: string; bootId: string }
export type ProcessInspection =
  | {kind: "present"; pid: number; birth: string; bootId: string; uid: number; ppid: number; pgid: number; state: "live" | "zombie"; startedAtMs: number; waitStatus: number | null}
  | {kind: "gone"}
  | {kind: "unavailable"; reason: "artifact_unavailable" | "native_observation_failed" | "permission_denied" | "invalid_result"};
let inspectionBridge: {processBirth(pid: number): unknown; inspectProcess(pid: number): unknown; inspect(fd: number): unknown; pin(fd: number): number; alive(fd: number): boolean} | null = null;
function processBridge() {
  if (!inspectionBridge) {
    const target = process.platform + "-" + process.arch;
    const root = fileURLToPath(new URL(fileURLToPath(import.meta.url).endsWith(".ts") ? "../../../dist/v2/peercred/" : "./peercred/", import.meta.url));
    const bridge = createRequire(import.meta.url)(validatePeerArtifact(join(root, target), target));
    if (typeof bridge.processBirth !== "function" || typeof bridge.inspectProcess !== "function" || typeof bridge.inspect !== "function" || typeof bridge.pin !== "function" || typeof bridge.alive !== "function") throw new Error("Process inspection bridge unavailable");
    inspectionBridge = bridge;
  }
  return inspectionBridge!;
}
export function decodeProcessInspection(value: unknown, pid: number): ProcessInspection {
  const unavailable = {kind: "unavailable", reason: "invalid_result"} as const;
  if (!value || typeof value !== "object") return unavailable;
  const v = value as Record<string, unknown>;
  if (v.kind === "gone" && Object.keys(v).length === 1) return {kind: "gone"};
  if (v.kind === "unavailable" && Object.keys(v).sort().join(",") === "kind,reason" && v.reason === "native_observation_failed") return {kind: "unavailable", reason: "native_observation_failed"};
  if (v.kind === "unavailable" && Object.keys(v).sort().join(",") === "kind,reason" && v.reason === "permission_denied") return {kind: "unavailable", reason: "permission_denied"};
  if (Object.keys(v).sort().join(",") !== "birth,bootId,kind,pgid,pid,ppid,startedAtMs,state,uid,waitStatus") return unavailable;
  if (v.kind !== "present" || v.pid !== pid || !Number.isSafeInteger(pid) || pid <= 0 || typeof v.birth !== "string" || !/^(?:linux:[0-9]+|darwin:[0-9]+:[0-9]+)$/.test(v.birth)) return unavailable;
  if (typeof v.bootId !== "string" || (v.birth.startsWith("linux:") ? !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v.bootId) : v.bootId !== "")) return unavailable;
  if (!processIdentityValue({pid, birth: v.birth, bootId: v.bootId})) return unavailable;
  if (![v.uid, v.ppid, v.pgid].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) || typeof v.startedAtMs !== "number" || !Number.isFinite(v.startedAtMs) || v.startedAtMs <= 0 || v.state !== "live" && v.state !== "zombie") return unavailable;
  if (typeof v.waitStatus !== "number" || !Number.isSafeInteger(v.waitStatus) || v.waitStatus < -1) return unavailable;
  return {kind: "present", pid, birth: v.birth, bootId: v.bootId, uid: Number(v.uid), ppid: Number(v.ppid), pgid: Number(v.pgid), state: v.state, startedAtMs: v.startedAtMs, waitStatus: v.waitStatus < 0 ? null : v.waitStatus};
}
export function inspectProcess(pid: number): ProcessInspection {
  if (!Number.isSafeInteger(pid) || pid <= 0) return {kind: "unavailable", reason: "invalid_result"};
  try { return decodeProcessInspection(processBridge().inspectProcess(pid), pid); }
  catch { return {kind: "unavailable", reason: "artifact_unavailable"}; }
}
export function sameProcess(identity: ProcessIdentity, value: ProcessInspection): value is Extract<ProcessInspection, {kind: "present"}> {
  return value.kind === "present" && value.pid === identity.pid && value.birth === identity.birth && value.bootId === identity.bootId;
}
export function authenticatedProcessPeer(fd: number, identity: ProcessIdentity): boolean {
  let pin = -1;
  try {
    const bridge = processBridge();
    const peer = bridge.inspect(fd) as {uid?: unknown; pid?: unknown; birth?: unknown} | null;
    if (!peer || peer.uid !== process.getuid?.() || peer.pid !== identity.pid || peer.birth !== identity.birth) return false;
    pin = bridge.pin(fd);
    const fresh = bridge.inspect(fd) as typeof peer;
    return (pin < 0 || bridge.alive(pin)) && !!fresh && fresh.uid === peer.uid && fresh.pid === peer.pid && fresh.birth === peer.birth && sameProcess(identity, inspectProcess(identity.pid));
  } catch { return false; } finally { if (pin >= 0) { try {closeSync(pin);} catch {} } }
}
export function exactProcessBirth(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const value = processBridge().processBirth(pid);
    return typeof value === "string" && /^(?:linux:[0-9]+|darwin:[0-9]+:[0-9]+)$/.test(value) ? value : null;
  } catch { return null; }
}
