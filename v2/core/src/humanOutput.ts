import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BeeRow, TurnTrigger } from "./types.ts";
import type { PhoneInput } from "./phoneOrigin.ts";
import { CoreError, IdempotencyConflictError } from "./types.ts";

export type HumanOutputMode = "legacy" | "explicit";
export interface UnansweredHumanMessage {
  messageId: number;
  generation: number;
  humanAt: number;
  triggerKind: "human" | "answer";
  phoneOrigin?: PhoneInput["envelope"];
}
export interface HumanOutputFacts {
  humanOutputMode: HumanOutputMode;
  humanAcknowledgementTrackingSince: number | null;
  lastHumanAcknowledgementAt: number | null;
  unansweredHumanMessage: UnansweredHumanMessage | null;
}
interface OutputProvenance {
  id: string;
  beeId: string;
  generation: number | null;
  turnTrigger: TurnTrigger | null;
  at: number;
  idempotencyKey: string;
}
export interface BeeTellRow extends OutputProvenance {
  text: string;
  replyTo: number | null;
  acknowledgedDeliveryRange: { afterSeq: number; throughSeq: number } | null;
  acknowledgedMessageIds: number[];
  acknowledgedOverflow: number;
}
export interface BeeReactionRow extends OutputProvenance {
  messageId: number;
  emoji: string;
}
export interface BeeTellParams { beeId: string; text: string; replyTo?: number; idempotencyKey: string }
export interface BeeReactParams { beeId: string; messageId: number; emoji: string; idempotencyKey: string }
export interface SetHumanOutputModeParams { beeId: string; mode: HumanOutputMode; idempotencyKey: string }
export interface BeeTellResult { tell: BeeTellRow; deduped?: true }
export interface BeeReactResult { reaction: BeeReactionRow; deduped?: true }
export interface SetHumanOutputModeResult extends HumanOutputFacts { beeId: string; deduped?: true }
export type HumanOutputErrorCode = "human_output_mode_legacy" | "human_output_target_invalid" | "tell_text_invalid" | "react_emoji_invalid" | "invalid_request";
export class HumanOutputError extends CoreError {
  readonly code: HumanOutputErrorCode;
  constructor(code: HumanOutputErrorCode, message: string) { super(message); this.code = code; }
}

export const HUMAN_OUTPUT_SQL = `
CREATE TABLE IF NOT EXISTS bee_human_output_state (
  bee_id TEXT PRIMARY KEY REFERENCES bees(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('legacy','explicit')),
  tracking_since INTEGER NOT NULL,
  last_ack_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS bee_human_deliveries (
  seq INTEGER PRIMARY KEY,
  bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  fact_json TEXT NOT NULL,
  UNIQUE(bee_id,message_id,generation)
) STRICT;
CREATE INDEX IF NOT EXISTS bee_human_deliveries_bee_seq ON bee_human_deliveries(bee_id,seq);
CREATE TABLE IF NOT EXISTS bee_human_acknowledgements (
  delivery_seq INTEGER PRIMARY KEY REFERENCES bee_human_deliveries(seq) ON DELETE CASCADE,
  output_id TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS bee_human_outputs (
  id TEXT PRIMARY KEY,
  bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('tell','react','mode')),
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  row_json TEXT NOT NULL,
  UNIQUE(bee_id,kind,idempotency_key)
) STRICT;
`;

function invalid(code: HumanOutputErrorCode, message: string): never { throw new HumanOutputError(code, message); }
function utf8(value: string): boolean { return !/[\ud800-\udfff]/u.test(value) && !value.includes("\0"); }
export function tellText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || !utf8(value) || Buffer.byteLength(value, "utf8") > 16 * 1024) invalid("tell_text_invalid", "Tell text must be nonempty UTF-8 without NUL, at most 16 KiB.");
  return value;
}
export function reactionEmoji(value: unknown): string {
  if (typeof value !== "string" || !utf8(value) || Buffer.byteLength(value) > 128 || [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)].length !== 1 || (!new RegExp("^\\p{RGI_Emoji}$", "v").test(value) || /^\p{Emoji_Component}$/u.test(value))) invalid("react_emoji_invalid", "Reaction must be exactly one Unicode emoji grapheme.");
  return value;
}
function key(value: string): void {
  if (typeof value !== "string" || !value.trim() || !utf8(value) || Buffer.byteLength(value) > 256) invalid("invalid_request", "idempotencyKey must be a nonempty UTF-8 string of at most 256 bytes.");
}

type SqlRow = Record<string, unknown>;
export class HumanOutputLedger {
  private db: Pick<DatabaseSync, "prepare">;
  private now: () => number;
  private audit: (kind: string, beeId: string, payload: Record<string, unknown>, at?: number) => number;
  constructor(db: Pick<DatabaseSync, "prepare">, now: () => number, audit: (kind: string, beeId: string, payload: Record<string, unknown>, at?: number) => number) {
    this.db = db; this.now = now; this.audit = audit;
  }

  facts(beeId: string): HumanOutputFacts {
    const state = this.db.prepare("SELECT * FROM bee_human_output_state WHERE bee_id = ?").get(beeId) as SqlRow | undefined;
    const pending = state && this.db.prepare("SELECT fact_json FROM bee_human_deliveries d WHERE bee_id = ? AND NOT EXISTS (SELECT 1 FROM bee_human_acknowledgements a WHERE a.delivery_seq = d.seq) ORDER BY seq LIMIT 1").get(beeId) as SqlRow | undefined;
    return {
      humanOutputMode: state?.mode === "explicit" ? "explicit" : "legacy",
      humanAcknowledgementTrackingSince: state ? Number(state.tracking_since) : null,
      lastHumanAcknowledgementAt: state?.last_ack_at == null ? null : Number(state.last_ack_at),
      unansweredHumanMessage: pending ? JSON.parse(String(pending.fact_json)) as UnansweredHumanMessage : null,
    };
  }

  private replay<T>(beeId: string, kind: string, idempotencyKey: string, request: unknown): T | null {
    key(idempotencyKey);
    const row = this.db.prepare("SELECT request_json,row_json FROM bee_human_outputs WHERE bee_id=? AND kind=? AND idempotency_key=?").get(beeId, kind, idempotencyKey) as SqlRow | undefined;
    if (!row) return null;
    if (row.request_json !== JSON.stringify(request)) throw new IdempotencyConflictError();
    return JSON.parse(String(row.row_json)) as T;
  }
  private save(beeId: string, kind: string, idempotencyKey: string, request: unknown, row: unknown, id: string): void {
    this.db.prepare("INSERT INTO bee_human_outputs VALUES(?,?,?,?,?,?)").run(id, beeId, kind, idempotencyKey, JSON.stringify(request), JSON.stringify(row));
  }
  setMode(bee: BeeRow, mode: HumanOutputMode, idempotencyKey: string): SetHumanOutputModeResult {
    if (mode !== "legacy" && mode !== "explicit") invalid("invalid_request", "Invalid human output mode.");
    const request = { mode };
    const original = this.replay<SetHumanOutputModeResult>(bee.id, "mode", idempotencyKey, request);
    if (original) return { ...original, deduped: true };
    const before = this.facts(bee.id);
    const at = this.now();
    this.db.prepare("INSERT INTO bee_human_output_state(bee_id,mode,tracking_since) VALUES(?,?,?) ON CONFLICT(bee_id) DO UPDATE SET mode=excluded.mode").run(bee.id, mode, at);
    const result = { beeId: bee.id, ...this.facts(bee.id) };
    this.save(bee.id, "mode", idempotencyKey, request, result, randomUUID());
    if (before.humanOutputMode !== mode || before.humanAcknowledgementTrackingSince === null) this.audit("bee.human_output_mode_changed", bee.id, { ...result }, at);
    return result;
  }

  delivery(beeId: string, seq: number, fact: UnansweredHumanMessage): HumanOutputFacts | null {
    if (this.facts(beeId).humanAcknowledgementTrackingSince === null) return null;
    this.db.prepare("INSERT OR IGNORE INTO bee_human_deliveries VALUES(?,?,?,?,?)").run(seq, beeId, fact.messageId, fact.generation, JSON.stringify(fact));
    return this.facts(beeId);
  }
  private target(beeId: string, messageId: number): number {
    if (!Number.isSafeInteger(messageId) || messageId < 1) invalid("human_output_target_invalid", "Target must be a human-origin delivery to this bee.");
    const row = this.db.prepare("SELECT seq FROM bee_human_deliveries WHERE bee_id=? AND message_id=? ORDER BY seq DESC LIMIT 1").get(beeId, messageId) as SqlRow | undefined;
    if (!row) invalid("human_output_target_invalid", "Target must be a human-origin delivery to this bee.");
    return Number(row.seq);
  }
  private explicit(beeId: string): void {
    if (this.facts(beeId).humanOutputMode !== "explicit") invalid("human_output_mode_legacy", "This bee has not opted into explicit human output.");
  }
  tell(bee: BeeRow, generation: number | null, params: BeeTellParams): BeeTellResult {
    if (params.replyTo !== undefined && (!Number.isSafeInteger(params.replyTo) || params.replyTo < 1)) invalid("human_output_target_invalid", "replyTo must be a human delivery message id.");
    const text = tellText(params.text), replyTo = params.replyTo ?? null;
    const request = { text, replyTo };
    const original = this.replay<BeeTellRow>(bee.id, "tell", params.idempotencyKey, request);
    if (original) return { tell: original, deduped: true };
    this.explicit(bee.id);
    const throughSeq = replyTo === null ? Number((this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM bee_human_deliveries WHERE bee_id=?").get(bee.id) as SqlRow).seq) : this.target(bee.id, replyTo);
    const first = this.db.prepare("SELECT MIN(seq) AS seq, COUNT(*) AS n FROM bee_human_deliveries d WHERE bee_id=? AND seq<=? AND NOT EXISTS(SELECT 1 FROM bee_human_acknowledgements a WHERE a.delivery_seq=d.seq)").get(bee.id, throughSeq) as SqlRow;
    const acknowledgedMessageIds = (this.db.prepare("SELECT message_id FROM bee_human_deliveries d WHERE bee_id=? AND seq<=? AND NOT EXISTS(SELECT 1 FROM bee_human_acknowledgements a WHERE a.delivery_seq=d.seq) ORDER BY seq LIMIT 64").all(bee.id, throughSeq) as SqlRow[]).map(row => Number(row.message_id));
    const at = this.now();
    const tell: BeeTellRow = { id: randomUUID(), beeId: bee.id, generation, turnTrigger: bee.lastTurnTrigger?.generation === generation ? bee.lastTurnTrigger : null, at, idempotencyKey: params.idempotencyKey, text, replyTo, acknowledgedMessageIds, acknowledgedOverflow: Math.max(0, Number(first.n) - acknowledgedMessageIds.length), acknowledgedDeliveryRange: first.seq == null ? null : { afterSeq: Number(first.seq) - 1, throughSeq } };
    this.db.prepare("INSERT INTO bee_human_acknowledgements SELECT seq,? FROM bee_human_deliveries WHERE bee_id=? AND seq<=? ON CONFLICT(delivery_seq) DO NOTHING").run(tell.id, bee.id, throughSeq);
    this.db.prepare("UPDATE bees SET last_human_output_at=MAX(COALESCE(last_human_output_at,?),?) WHERE id=?").run(at, at, bee.id);
    this.db.prepare("UPDATE bee_human_output_state SET last_ack_at=MAX(COALESCE(last_ack_at,?),?) WHERE bee_id=?").run(at, at, bee.id);
    this.save(bee.id, "tell", params.idempotencyKey, request, tell, tell.id);
    const lastHumanOutputAt = (this.db.prepare("SELECT last_human_output_at FROM bees WHERE id=?").get(bee.id) as SqlRow).last_human_output_at;
    this.audit("bee.told", bee.id, { tell, lastHumanOutputAt, ...this.facts(bee.id) }, at);
    return { tell };
  }
  react(bee: BeeRow, generation: number | null, params: BeeReactParams): BeeReactResult {
    const emoji = reactionEmoji(params.emoji), request = { messageId: params.messageId, emoji };
    const original = this.replay<BeeReactionRow>(bee.id, "react", params.idempotencyKey, request);
    if (original) return { reaction: original, deduped: true };
    this.explicit(bee.id);
    const seq = this.target(bee.id, params.messageId), at = this.now();
    const reaction: BeeReactionRow = { id: randomUUID(), beeId: bee.id, generation, turnTrigger: bee.lastTurnTrigger?.generation === generation ? bee.lastTurnTrigger : null, at, idempotencyKey: params.idempotencyKey, ...request };
    this.db.prepare("INSERT INTO bee_human_acknowledgements VALUES(?,?) ON CONFLICT(delivery_seq) DO NOTHING").run(seq, reaction.id);
    this.db.prepare("UPDATE bee_human_output_state SET last_ack_at=MAX(COALESCE(last_ack_at,?),?) WHERE bee_id=?").run(at, at, bee.id);
    this.save(bee.id, "react", params.idempotencyKey, request, reaction, reaction.id);
    this.audit("bee.reacted", bee.id, { reaction, ...this.facts(bee.id) }, at);
    return { reaction };
  }
  list<T extends BeeTellRow | BeeReactionRow>(kind: "tell" | "react"): T[] {
    return (this.db.prepare("SELECT row_json FROM bee_human_outputs WHERE kind=? ORDER BY id").all(kind) as SqlRow[]).map(row => JSON.parse(String(row.row_json)) as T);
  }
}
