import { posix } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, assertCanonicalData, type JsonValue } from "../../../src/comb/canonical.ts";

export const EXTERNAL_EXEC = "external-exec-v1";
export const EXTERNAL_EXEC_CAPABILITY = "external-exec.v1";
export type BridgeOperation = "start" | "wait" | "stop" | "reconcile";
export type BridgeStatus = "completed" | "failed" | "stopped" | "interrupted";
export interface BridgeRegistration {
  executable: string;
  executableSha256: string;
  filesManifest: string;
  filesManifestSha256: string;
  payloadManifest: string;
  payloadManifestSha256: string;
}
export interface ExternalExecConfig {
  bridges: Record<string, BridgeRegistration>;
  workspaces: Record<string, { capabilities: string[]; bridges: string[] }>;
}
export interface ExternalDispatch {
  schema: "urbench.dispatch.v1";
  attemptId: string;
  fencingToken: string;
  mode: "no-inference";
  stateDir: string;
  prompt: { path: string; sha256: string; bytes: number };
  inputSnapshot: { path: string; sha256: string };
  guest: { baseIdentity: string; profileFingerprint: string; policySha256: string };
  requested: { model: string; effort: string };
  limits: { cpus: number; memoryMiB: number; wallSeconds: number };
  auth: { handle: ""; claim: null; accountId: null };
}
export interface ExternalBinding {
  beeId: string;
  bridgeId: string;
  workspace: string;
  admissionDigest: string;
  registration: BridgeRegistration;
  dispatch: ExternalDispatch;
}
export interface BridgeReceipt extends Record<string, JsonValue> {
  schema: "urbench.receipt.v1";
  attemptId: string;
  fencingTokenSha256: string;
  dispatchManifestSha256: string;
  installManifestSha256: string;
  status: BridgeStatus;
  mode: "no-inference";
  qualified: false;
}
export const EXTERNAL_EXEC_SQL = `CREATE TABLE IF NOT EXISTS external_exec (
  bee_id TEXT PRIMARY KEY REFERENCES bees(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL UNIQUE,
  binding TEXT NOT NULL,
  receipt_path TEXT NOT NULL,
  dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)),
  receipt TEXT,
  failure TEXT
) STRICT;`;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function dispatchBytes(value: ExternalDispatch): string {
  assertCanonicalData(value);
  return `${canonicalJson(value).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("external_exec_invalid_object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(",") !== expected.sort().join(",")) throw new Error("external_exec_invalid_shape");
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
}
export function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function registrationValue(value: unknown): BridgeRegistration {
  const v = record(value);
  keys(v, ["executable", "executableSha256", "filesManifest", "filesManifestSha256", "payloadManifest", "payloadManifestSha256"]);
  for (const key of ["executable", "filesManifest", "payloadManifest"]) if (!text(v[key]) || !String(v[key]).startsWith("/")) throw new Error("external_exec_absolute_path_required");
  for (const key of ["executableSha256", "filesManifestSha256", "payloadManifestSha256"]) if (!hash(v[key])) throw new Error("external_exec_invalid_hash");
  return { executable: String(v.executable), executableSha256: String(v.executableSha256), filesManifest: String(v.filesManifest), filesManifestSha256: String(v.filesManifestSha256), payloadManifest: String(v.payloadManifest), payloadManifestSha256: String(v.payloadManifestSha256) };
}
export function externalConfig(value: unknown): ExternalExecConfig {
  if (value === undefined) return { bridges: {}, workspaces: {} };
  const v = record(value); keys(v, ["bridges", "workspaces"]);
  const bridges = Object.fromEntries(Object.entries(record(v.bridges)).map(([id, entry]) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("external_exec_invalid_bridge_id");
    return [id, registrationValue(entry)];
  }));
  const workspaces = Object.fromEntries(Object.entries(record(v.workspaces)).map(([id, entry]) => {
    const w = record(entry); keys(w, ["capabilities", "bridges"]);
    if (!id || !Array.isArray(w.capabilities) || w.capabilities.some(x => x !== EXTERNAL_EXEC_CAPABILITY) || !Array.isArray(w.bridges) || w.bridges.some(x => typeof x !== "string" || !Object.hasOwn(bridges, x))) throw new Error("external_exec_invalid_workspace");
    return [id, { capabilities: w.capabilities as string[], bridges: w.bridges as string[] }];
  }));
  return { bridges, workspaces };
}
export function dispatchValue(value: unknown): ExternalDispatch {
  const v = record(value);
  keys(v, ["schema", "attemptId", "fencingToken", "mode", "stateDir", "prompt", "inputSnapshot", "guest", "requested", "limits", "auth"]);
  if (v.schema !== "urbench.dispatch.v1" || v.mode !== "no-inference" || typeof v.attemptId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.attemptId) || typeof v.fencingToken !== "string" || v.fencingToken.length < 16 || v.fencingToken.length > 256 || /[\x00-\x1f]/.test(v.fencingToken)) throw new Error("external_exec_invalid_dispatch");
  const p = record(v.prompt), i = record(v.inputSnapshot), g = record(v.guest), r = record(v.requested), l = record(v.limits), a = record(v.auth);
  keys(p, ["path", "sha256", "bytes"]); keys(i, ["path", "sha256"]); keys(g, ["baseIdentity", "profileFingerprint", "policySha256"]); keys(r, ["model", "effort"]); keys(l, ["cpus", "memoryMiB", "wallSeconds"]); keys(a, ["handle", "claim", "accountId"]);
  for (const path of [v.stateDir, p.path, i.path]) if (!text(path) || !path.startsWith("/") || posix.normalize(path) !== path) throw new Error("external_exec_invalid_path");
  if (![p.sha256, i.sha256, g.baseIdentity, g.profileFingerprint, g.policySha256].every(hash) || !Number.isSafeInteger(p.bytes) || Number(p.bytes) < 0 || !text(r.model) || !text(r.effort) || ![l.cpus, l.memoryMiB, l.wallSeconds].every(x => Number.isSafeInteger(x) && Number(x) > 0)) throw new Error("external_exec_invalid_dispatch");
  if (a.handle !== "" || a.claim !== null || a.accountId !== null) throw new Error("external_exec_auth_not_authorized");
  assertCanonicalData(value);
  if (Buffer.byteLength(canonicalJson(value)) > 2 * 1024 * 1024 - 1) throw new Error("external_exec_dispatch_too_large");
  return JSON.parse(canonicalJson(value)) as ExternalDispatch;
}
export function validateReceipt(value: unknown, binding: ExternalBinding): BridgeReceipt {
  const v = record(value);
  keys(v, ["schema", "attemptId", "fencingTokenSha256", "dispatchManifestSha256", "installManifestSha256", "status", "mode", "qualified", "nativeReceipt", "captureErrors", "evidence", "auth"]);
  const native = record(v.nativeReceipt), evidence = record(v.evidence), auth = record(v.auth);
  keys(native, ["path", "sha256"]); keys(auth, ["handle", "accountId", "release"]);
  if (native.path !== posix.join(binding.dispatch.stateDir, "attempts", binding.dispatch.attemptId, "terminal.json") || !hash(native.sha256) || !Array.isArray(v.captureErrors) || v.captureErrors.some(x => typeof x !== "string") || Object.entries(evidence).some(([path, digest]) => path.startsWith("/") || path.split("/").includes("..") || !hash(digest)) || auth.handle !== "" || auth.accountId !== null || auth.release !== "not-applicable-no-inference") throw new Error("external_exec_invalid_receipt_evidence");
  if (v.schema !== "urbench.receipt.v1" || v.attemptId !== binding.dispatch.attemptId || v.fencingTokenSha256 !== sha256(binding.dispatch.fencingToken) || v.dispatchManifestSha256 !== sha256(dispatchBytes(binding.dispatch)) || v.installManifestSha256 !== binding.registration.payloadManifestSha256 || v.mode !== "no-inference" || v.qualified !== false || !["completed", "failed", "stopped", "interrupted"].includes(String(v.status))) throw new Error("external_exec_receipt_binding_mismatch");
  assertCanonicalData(v);
  if (JSON.stringify(v).includes(binding.dispatch.fencingToken)) throw new Error("external_exec_receipt_contains_capability");
  return v as BridgeReceipt;
}

export interface ExternalExecutionView {
  bridgeId: string;
  workspace: string;
  attemptId: string;
  dispatched: boolean;
  status: BridgeStatus | "pending";
  observation: "pending" | "terminal" | "reconcile_required";
}
export class ExternalExecutions {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  get(beeId: string): ExternalBinding | null {
    const row = this.db.prepare("SELECT binding FROM external_exec WHERE bee_id=?").get(beeId);
    if (!row) return null;
    const stored = record(JSON.parse(String(row.binding)));
    if (stored.beeId !== beeId || typeof stored.bridgeId !== "string" || typeof stored.workspace !== "string" || typeof stored.admissionDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(stored.admissionDigest)) throw new Error("external_exec_corrupt_binding");
    return { beeId, bridgeId: stored.bridgeId, workspace: stored.workspace, admissionDigest: stored.admissionDigest, registration: registrationValue(stored.registration), dispatch: dispatchValue(stored.dispatch) };
  }
  view(beeId: string): ExternalExecutionView | null {
    const binding = this.get(beeId);
    if (!binding) return null;
    const row = this.db.prepare("SELECT dispatched,receipt,failure FROM external_exec WHERE bee_id=?").get(beeId)!;
    const receipt = row.receipt ? validateReceipt(JSON.parse(String(row.receipt)), binding) : null;
    return { bridgeId: binding.bridgeId, workspace: binding.workspace, attemptId: binding.dispatch.attemptId, dispatched: row.dispatched === 1, status: receipt?.status ?? "pending", observation: row.failure ? "reconcile_required" : receipt ? "terminal" : "pending" };
  }
  admit(binding: ExternalBinding): void {
    this.db.prepare("INSERT INTO external_exec(bee_id,attempt_id,binding,receipt_path) VALUES(?,?,?,?)").run(binding.beeId, binding.dispatch.attemptId, JSON.stringify(binding), posix.join(binding.dispatch.stateDir, "control", binding.dispatch.attemptId, "receipt.json"));
  }
  claimDispatch(beeId: string): "start" | "reconcile" {
    const row = this.db.prepare("SELECT dispatched FROM external_exec WHERE bee_id=?").get(beeId);
    if (!row) throw new Error("external_exec_missing_binding");
    if (row.dispatched === 1) return "reconcile";
    this.db.prepare("UPDATE external_exec SET dispatched=1 WHERE bee_id=?").run(beeId);
    return "start";
  }
  fail(beeId: string): boolean {
    return this.db.prepare("UPDATE external_exec SET failure='reconcile_required' WHERE bee_id=? AND failure IS NULL").run(beeId).changes > 0;
  }
  settle(beeId: string, value: unknown): BridgeReceipt {
    const binding = this.get(beeId);
    if (!binding) throw new Error("external_exec_missing_binding");
    const receipt = validateReceipt(value, binding);
    const old = this.db.prepare("SELECT receipt FROM external_exec WHERE bee_id=?").get(beeId);
    if (old?.receipt && canonicalJson(JSON.parse(String(old.receipt))) !== canonicalJson(receipt)) throw new Error("external_exec_terminal_conflict");
    this.db.prepare("UPDATE external_exec SET receipt=? WHERE bee_id=? AND receipt IS NULL").run(JSON.stringify(receipt), beeId);
    return receipt;
  }
}

export interface BridgeEvent extends Record<string, unknown> {
  schema: "urbench.bridge.event.v1";
  type: string;
  seq: number;
  data: Record<string, unknown>;
}

export function bridgeEvent(value: unknown, binding: ExternalBinding, seq: number): BridgeEvent {
  const event = record(value);
  if (Object.keys(event).sort().join(",") !== "attemptId,data,fencingTokenSha256,schema,seq,type" || event.schema !== "urbench.bridge.event.v1" || event.seq !== seq || event.attemptId !== binding.dispatch.attemptId || event.fencingTokenSha256 !== sha256(binding.dispatch.fencingToken) || !["started", "status", "stop_requested", "waiting", "terminal", "error"].includes(String(event.type))) throw new Error("external_exec_invalid_event");
  record(event.data);
  if (JSON.stringify(event).includes(binding.dispatch.fencingToken)) throw new Error("external_exec_event_contains_capability");
  if (event.type === "terminal") validateReceipt(event.data, binding);
  return event as BridgeEvent;
}
