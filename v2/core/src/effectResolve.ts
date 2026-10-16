import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const EFFECT_RESOLVE_CAPABILITY = "rpc-effect-resolve.v1";
export const EFFECT_VERBS = ["spawn", "send", "archive"] as const;
export type EffectVerb = typeof EFFECT_VERBS[number];
export type EffectReceipt = { key: string; verb: string; commandId: number | null; result: unknown; createdAt: number };
export type EffectCoverage = { ownerStoreId: string; coverageId: string };
export type EffectResolution = EffectCoverage & { verb: EffectVerb; idempotencyKey: string } & (
  { status: "committed"; receipt: EffectReceipt; commandStatus?: string }
  | { status: "never_seen_fenced" | "in_flight" }
);
export class EffectKeyError extends Error {
  constructor(readonly code: "rpc_effect_fenced" | "rpc_effect_history_unknown" | "idempotency_conflict" | "invalid_request", message: string) {
    super(message);
    this.name = "EffectKeyError";
  }
}
export function effectVerb(value: unknown): EffectVerb {
  if (!(EFFECT_VERBS as readonly unknown[]).includes(value)) throw new EffectKeyError("invalid_request", "Effect verb must be spawn, send or archive");
  return value as EffectVerb;
}
function key(value: string): void {
  if (typeof value !== "string" || !value.length || value.length > 1024) throw new EffectKeyError("invalid_request", "Effect key must be a nonempty bounded string");
}

export class EffectLedger {
  private coverage!: EffectCoverage;
  constructor(private readonly db: DatabaseSync, private readonly now: () => number) {}
  open(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS rpc_effect_keys (key TEXT PRIMARY KEY, verb TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('committed','fenced')), receipt TEXT, created_at INTEGER NOT NULL) STRICT");
    const row = this.db.prepare("SELECT value FROM meta WHERE key='rpc_effect_owner'").get();
    const ownerStoreId = row ? String(row.value) : randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(ownerStoreId)) throw new EffectKeyError("invalid_request", "Corrupt effect owner identity");
    this.db.prepare("INSERT INTO meta(key,value) VALUES('rpc_effect_owner',?) ON CONFLICT(key) DO NOTHING").run(ownerStoreId);
    this.coverage = { ownerStoreId, coverageId: randomUUID() };
    this.db.prepare("INSERT INTO meta(key,value) VALUES('rpc_effect_coverage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.coverage.coverageId);
    for (const row of this.db.prepare("SELECT * FROM rpc_idempotency WHERE verb IN ('spawn','send','archive')").all()) {
      const existing = this.raw(String(row.key));
      if (existing?.state === "committed") continue;
      if (existing) this.db.prepare("DELETE FROM rpc_effect_keys WHERE key=?").run(String(row.key));
      this.record({ key: String(row.key), verb: String(row.verb), commandId: row.command_id === null ? null : Number(row.command_id), result: JSON.parse(String(row.result)), createdAt: Number(row.created_at) });
    }
  }
  status(): EffectCoverage { return { ...this.coverage }; }
  private raw(id: string): { verb: string; state: string; receipt: EffectReceipt | null } | null {
    key(id);
    const row = this.db.prepare("SELECT * FROM rpc_effect_keys WHERE key=?").get(id);
    if (!row) return null;
    effectVerb(row.verb);
    if (row.state !== "committed" && row.state !== "fenced") throw new EffectKeyError("invalid_request", "Corrupt effect key state");
    const receipt = row.receipt === null ? null : JSON.parse(String(row.receipt)) as EffectReceipt;
    if ((row.state === "committed") !== (receipt !== null) || receipt && (receipt.key !== id || receipt.verb !== row.verb || typeof receipt.createdAt !== "number" || !Object.hasOwn(receipt, "result") || receipt.commandId !== null && !Number.isSafeInteger(receipt.commandId))) throw new EffectKeyError("invalid_request", "Corrupt effect receipt");
    return { verb: String(row.verb), state: String(row.state), receipt };
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
