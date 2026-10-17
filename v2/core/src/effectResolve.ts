import { CoreError } from "./types.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const EFFECT_RESOLVE_CAPABILITY = "rpc-effect-resolve.v1";
export const EFFECT_VERBS = ["spawn", "send", "archive"] as const;
export const EFFECT_RESULT_REQUIRED_FIELDS = {
  spawn: { beeId: "nonempty-string", commandId: "command-id-or-null" },
  send: { messageId: "positive-integer", commandId: "command-id-or-null", unarchived: "boolean" },
  archive: { commandId: "positive-integer" },
} as const;
export type EffectVerb = typeof EFFECT_VERBS[number];
export type EffectReceipt = { key: string; verb: string; commandId: number | null; result: unknown; createdAt: number };
export type EffectCoverage = { ownerStoreId: string; coverageId: string };
export type EffectResolution = EffectCoverage & { verb: EffectVerb; idempotencyKey: string } & (
  { status: "committed"; receipt: EffectReceipt; commandStatus?: string }
  | { status: "never_seen_fenced" | "in_flight" }
);
export class EffectKeyError extends CoreError {
  readonly code: "rpc_effect_fenced" | "rpc_effect_history_unknown" | "idempotency_conflict" | "invalid_request";
  constructor(code: "rpc_effect_fenced" | "rpc_effect_history_unknown" | "idempotency_conflict" | "invalid_request", message: string) {
    super(message);
    this.name = "EffectKeyError";
    this.code = code;
  }
}
export function effectVerb(value: unknown): EffectVerb {
  if (!(EFFECT_VERBS as readonly unknown[]).includes(value)) throw new EffectKeyError("invalid_request", "Effect verb must be spawn, send or archive");
  return value as EffectVerb;
}
function key(value: string): void {
  if (typeof value !== "string" || !value.length) throw new EffectKeyError("invalid_request", "Effect key must be a nonempty string");
}

function validEffectResult(verb: EffectVerb, value: unknown, commandId: number | null): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const text = (v: unknown) => typeof v === "string" && v.length > 0;
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const positive = (v: unknown) => number(v) && Number.isSafeInteger(v) && (v as number) > 0;
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const member = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value);
  const optional = (row: Record<string, unknown>, name: string, check: (v: unknown) => boolean) => !Object.hasOwn(row, name) || check(row[name]);
  for (const [name, type] of Object.entries(EFFECT_RESULT_REQUIRED_FIELDS[verb])) {
    if (!Object.hasOwn(result, name)) return false;
    const field = result[name];
    if (type === "nonempty-string" && !text(field) || type === "positive-integer" && !positive(field)
      || type === "command-id-or-null" && field !== null && !positive(field) || type === "boolean" && typeof field !== "boolean") return false;
  }
  if (!optional(result, "generation", positive)) return false;
  if (!optional(result, "requestBinding", v => object(v) && v.version === 1 && v.verb === verb && member(v.lane, ["envelope-v1", "interim-v1", "legacy"]) && text(v.requestDigest))) return false;
  if (!optional(result, "phoneAdmission", v => object(v) && text(v.ownerStoreId) && text(v.admissionId) && (v.contentDigest === null || typeof v.contentDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(v.contentDigest)) && v.lane === "envelope-v1")) return false;
  if (!optional(result, "commandId", v => v === commandId) || !optional(result, "messageId", v => v === null || positive(v))) return false;
  for (const name of ["agent", "accountReason", "allocationClaimId"]) if (!optional(result, name, text)) return false;
  for (const name of ["handle", "humanRef", "issuingNamespace", "account"]) if (!optional(result, name, v => v === null || text(v))) return false;
  for (const name of ["unarchived", "deduped"]) if (!optional(result, name, v => typeof v === "boolean")) return false;
  if (!optional(result, "status", v => member(v, ["queued", "running", "done", "failed"]))) return false;
  if (!optional(result, "runtimeStartHold", v => object(v) && v.code === "account_auth_needed" && v.message === "Waiting for refreshed account material")) return false;
  if (!optional(result, "cellBase", v => object(v) && text(v.sha) && member(v.source, ["pinned", "head", "upstream"]) && optional(v, "upstreamRef", text) && optional(v, "upstreamSha", text) && optional(v, "fetchedAt", number))) return false;
  if (!optional(result, "allocation", v => object(v) && v.version === 1 && member(v.mode, ["shadow", "active"]) && text(v.scope)
    && (v.revision === null || text(v.revision)) && number(v.observedAt) && member(v.operation, ["spawn", "fork", "handoff", "swap"])
    && member(v.outcome, ["selected", "wait"]) && (v.account === null || text(v.account)) && text(v.reason) && (v.retryAt === null || number(v.retryAt))
    && Array.isArray(v.candidates) && v.candidates.every(c => object(c) && text(c.accountId) && member(c.status, ["eligible", "ineligible", "uncertain", "protected"])
      && optional(c, "reason", text) && ["rate", "fairFinish", "maxProjectedPercent"].every(name => optional(c, name, number))))) return false;
  return true;
}

export class EffectLedger {
  private coverage!: EffectCoverage;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(db: DatabaseSync, now: () => number) { this.db = db; this.now = now; }
  open(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS rpc_effect_keys (key TEXT PRIMARY KEY, verb TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('committed','fenced')), receipt TEXT, created_at INTEGER NOT NULL) STRICT");
    const row = this.db.prepare("SELECT value FROM meta WHERE key='rpc_effect_owner'").get();
    const ownerStoreId = row ? String(row.value) : randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(ownerStoreId)) throw new EffectKeyError("invalid_request", "Corrupt effect owner identity");
    this.db.prepare("INSERT INTO meta(key,value) VALUES('rpc_effect_owner',?) ON CONFLICT(key) DO NOTHING").run(ownerStoreId);
    this.coverage = { ownerStoreId, coverageId: randomUUID() };
    this.db.prepare("INSERT INTO meta(key,value) VALUES('rpc_effect_coverage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.coverage.coverageId);

  }
  status(): EffectCoverage { return { ...this.coverage }; }
  private raw(id: string): { verb: string; state: string; receipt: EffectReceipt | null } | null {
    key(id);
    const row = this.db.prepare("SELECT * FROM rpc_effect_keys WHERE key=?").get(id);
    const legacy = this.db.prepare("SELECT * FROM rpc_idempotency WHERE key=? AND verb IN ('spawn','send','archive')").get(id);
    const unknown = (): never => { throw new EffectKeyError("rpc_effect_history_unknown", "Effect receipt is unreadable or unknown; hold the effect"); };
    if (!row && !legacy) return null;
    if (row && (typeof row.verb !== "string" || !(EFFECT_VERBS as readonly string[]).includes(row.verb) || row.state !== "committed" && row.state !== "fenced")) return unknown();
    if (row?.state === "fenced" && !legacy) {
      if (row.receipt !== null) return unknown();
      return { verb: String(row.verb), state: "fenced", receipt: null };
    }
    let receipt: unknown;
    try {
      receipt = row?.state === "committed"
        ? JSON.parse(String(row.receipt))
        : { key: id, verb: legacy!.verb, commandId: legacy!.command_id, result: JSON.parse(String(legacy!.result)), createdAt: legacy!.created_at };
    } catch { return unknown(); }
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return unknown();
    const value = receipt as EffectReceipt;
    if (value.key !== id || !(EFFECT_VERBS as readonly string[]).includes(value.verb) || row && value.verb !== row.verb || !Number.isFinite(value.createdAt) || value.createdAt < 0 || value.commandId !== null && (!Number.isSafeInteger(value.commandId) || value.commandId <= 0) || !Object.hasOwn(value, "result")) return unknown();
    if (!validEffectResult(value.verb as EffectVerb, value.result, value.commandId)) return unknown();
    if (row?.state !== "committed") this.db.prepare("INSERT INTO rpc_effect_keys(key,verb,state,receipt,created_at) VALUES(?,?,'committed',?,?) ON CONFLICT(key) DO UPDATE SET verb=excluded.verb,state=excluded.state,receipt=excluded.receipt,created_at=excluded.created_at").run(id, value.verb, JSON.stringify(value), value.createdAt);
    return { verb: value.verb, state: "committed", receipt: value };
  }
  lookup(id: string, verb?: string): EffectReceipt | null {
    const row = this.raw(id);
    if (row?.state === "fenced") throw new EffectKeyError("rpc_effect_fenced", "Effect key is permanently fenced");
    if (row && verb !== undefined && row.verb !== verb) throw new EffectKeyError("idempotency_conflict", "Effect key belongs to another verb");
    if (row?.receipt) return row.receipt;
    if (id.startsWith("effect-v1:") && !this.covered(id)) throw new EffectKeyError("rpc_effect_history_unknown", "Effect key coverage is retired or unknown; hold the effect");
    return null;
  }
  private covered(id: string): boolean {
    const prefix = `effect-v1:${this.coverage.coverageId}:`;
    return id.startsWith(prefix) && /^[a-zA-Z0-9_-]{1,128}$/.test(id.slice(prefix.length));
  }
  record(receipt: EffectReceipt): void {
    if (!(EFFECT_VERBS as readonly string[]).includes(receipt.verb)) return;
    const existing = this.raw(receipt.key);
    if (existing) {
      if (existing.state === "fenced") throw new EffectKeyError("rpc_effect_fenced", "Effect key is permanently fenced");
      throw new EffectKeyError("idempotency_conflict", "Effect key is already committed");
    }
    this.db.prepare("INSERT INTO rpc_effect_keys(key,verb,state,receipt,created_at) VALUES(?,?,'committed',?,?)").run(receipt.key, receipt.verb, JSON.stringify(receipt), receipt.createdAt);
  }
  observe(id: string, verb: EffectVerb): EffectResolution {
    const row = this.raw(id), binding = { ...this.coverage, verb, idempotencyKey: id };
    if (row && row.verb !== verb) throw new EffectKeyError("idempotency_conflict", "Effect key belongs to another verb");
    if (row?.receipt) return { ...binding, status: "committed", receipt: row.receipt };
    if (this.covered(id) && row?.state === "fenced") return { ...binding, status: "never_seen_fenced" };
    throw new EffectKeyError("rpc_effect_history_unknown", "No authoritative execution receipt or current non-execution fence; hold the effect");
  }
  resolve(id: string, verb: EffectVerb, inFlight: boolean, commandExists: boolean): EffectResolution {
    const row = this.raw(id), binding = { ...this.coverage, verb, idempotencyKey: id };
    if (row && row.verb !== verb) throw new EffectKeyError("idempotency_conflict", "Effect key belongs to another verb");
    if (row?.receipt) return { ...binding, status: "committed", receipt: row.receipt };
    if (!this.covered(id) || commandExists) throw new EffectKeyError("rpc_effect_history_unknown", "Effect history is unknown; hold the effect");
    if (row?.state === "fenced") return { ...binding, status: "never_seen_fenced" };
    if (inFlight) return { ...binding, status: "in_flight" };
    this.db.prepare("INSERT INTO rpc_effect_keys(key,verb,state,receipt,created_at) VALUES(?,?,'fenced',NULL,?)").run(id, verb, this.now());
    return { ...binding, status: "never_seen_fenced" };
  }
}
