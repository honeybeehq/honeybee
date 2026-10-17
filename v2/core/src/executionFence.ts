import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./types.ts";
import { assertCanonicalData, canonicalDigest, type JsonValue } from "../../../src/comb/canonical.ts";
import type { EffectCoverage } from "./effectResolve.ts";

export const EXECUTION_FENCE_CAPABILITY = "rpc-execution-fence.archive-send.v1";
export type ExecutionVerb = "send" | "archive";
export type ExecutionCode = "rpc_execution_stale" | "rpc_execution_busy" | "rpc_execution_history_unknown" | "rpc_execution_fence_unsupported" | "idempotency_conflict" | "invalid_request" | "caller_not_trusted";
export class ExecutionFenceError extends CoreError {
  readonly code: ExecutionCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ExecutionCode, message: string, details?: Record<string, unknown>) {
    super(message); this.name = "ExecutionFenceError"; this.code = code; this.details = details;
  }
}
export interface ExecutionToken extends EffectCoverage {
  version: 1;
  issuerId: string;
  continuationId: string;
  generation: number;
  claimId: string;
  grantDigest: string;
}
export interface ExecutionBinding {
  verb: ExecutionVerb;
  resource: { beeId: string };
  digestVersion: 1;
  requestDigest: string;
  idempotencyKey: string;
}
export type ExecutionClaim = ExecutionToken & ExecutionBinding;
export interface ExecutionRequest extends ExecutionBinding {
  executionFence: ExecutionToken;
  args: Record<string, JsonValue>;
}
export type ExecutionReceipt = ExecutionClaim & {
  status: "queued" | "completed" | "refused_stale";
  boundary: "mailbox-admission" | "lifecycle-transaction";
  commandId: number | null;
  result: unknown;
};
function invalid(message: string): never { throw new ExecutionFenceError("invalid_request", message); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) invalid("Invalid closed execution-fence shape");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) invalid("Invalid execution-fence identifier");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid("Invalid execution-fence digest");
  return value;
}
const TOKEN_KEYS = ["version", "issuerId", "continuationId", "generation", "claimId", "grantDigest", "ownerStoreId", "coverageId"];
const BINDING_KEYS = ["verb", "resource", "digestVersion", "requestDigest", "idempotencyKey"];
export function executionToken(value: unknown): ExecutionToken {
  const row = object(value, TOKEN_KEYS);
  if (row.version !== 1 || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1) invalid("Invalid execution generation");
  return { version: 1, issuerId: text(row.issuerId), continuationId: text(row.continuationId), generation: Number(row.generation), claimId: text(row.claimId), grantDigest: digest(row.grantDigest), ownerStoreId: text(row.ownerStoreId), coverageId: text(row.coverageId) };
}
function binding(value: Record<string, unknown>): ExecutionBinding {
  if (value.verb === "spawn") throw new ExecutionFenceError("rpc_execution_fence_unsupported", "Spawn execution fencing requires phase B; no fallback is permitted");
  if (value.verb !== "send" && value.verb !== "archive") invalid("Execution verb must be send or archive");
  if (value.digestVersion !== 1) invalid("Unsupported execution digest version");
  const resource = object(value.resource, ["beeId"]);
  return { digestVersion: 1, verb: value.verb, resource: { beeId: text(resource.beeId) }, requestDigest: digest(value.requestDigest), idempotencyKey: text(value.idempotencyKey) };
}
export function executionClaim(value: unknown): ExecutionClaim {
  const row = object(value, [...TOKEN_KEYS, ...BINDING_KEYS]);
  return { ...executionToken(Object.fromEntries(TOKEN_KEYS.map(key => [key, row[key]]))), ...binding(row) };
}
export function executionRequestDigest(verb: ExecutionVerb, resource: { beeId: string }, args: Record<string, JsonValue>): string {
  return canonicalDigest({ version: 1, verb, resource, args });
}
export function executionRequest(value: unknown): ExecutionRequest {
  const row = object(value, [...BINDING_KEYS, "executionFence", "args"]), bound = binding(row);
  if (!row.args || typeof row.args !== "object" || Array.isArray(row.args)) invalid("Execution args must be an object");
  const args = row.args as Record<string, JsonValue>;
  const allowed = bound.verb === "archive" ? ["beeId"] : ["beeId", "body", "sender", "urgency", "senderKind"];
  if (Object.keys(args).some(key => !allowed.includes(key)) || args.beeId !== bound.resource.beeId || bound.verb === "send" && typeof args.body !== "string") invalid("Execution args do not match the resource or verb");
  try { assertCanonicalData(args); } catch { invalid("Execution args must be canonical JSON data"); }
  if (executionRequestDigest(bound.verb, bound.resource, args) !== bound.requestDigest) invalid("Execution request digest mismatch");
  return { ...bound, executionFence: executionToken(row.executionFence), args };
}
function same(a: unknown, b: unknown): boolean { return canonicalDigest(a as JsonValue) === canonicalDigest(b as JsonValue); }

export class ExecutionLedger {
  private readonly db: DatabaseSync;
  private readonly coverage: () => EffectCoverage;
  private readonly now: () => number;
  private readonly audit: (kind: string, beeId: string | null, data: Record<string, unknown>) => void;
  constructor(db: DatabaseSync, now: () => number, coverage: () => EffectCoverage, audit: (kind: string, beeId: string | null, data: Record<string, unknown>) => void) { this.db = db; this.now = now; this.coverage = coverage; this.audit = audit; }
  open(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS rpc_execution_coordinators (issuer_id TEXT PRIMARY KEY, uid INTEGER NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS rpc_execution_claims (issuer_id TEXT NOT NULL, continuation_id TEXT NOT NULL, claim TEXT NOT NULL, PRIMARY KEY(issuer_id,continuation_id)) STRICT; CREATE TABLE IF NOT EXISTS rpc_execution_transitions (issuer_id TEXT NOT NULL, transition_id TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(issuer_id,transition_id)) STRICT; CREATE TABLE IF NOT EXISTS rpc_execution_effects (key TEXT PRIMARY KEY, binding TEXT NOT NULL, receipt TEXT NOT NULL, command_id INTEGER UNIQUE) STRICT; CREATE TABLE IF NOT EXISTS rpc_execution_refusals (digest TEXT PRIMARY KEY, receipt TEXT NOT NULL) STRICT");
  }
  register(issuerId: unknown, uid: number): { issuerId: string; uid: number } {
    const issuer = text(issuerId), previous = this.db.prepare("SELECT uid FROM rpc_execution_coordinators WHERE issuer_id=?").get(issuer);
    if (previous && previous.uid !== uid) throw new ExecutionFenceError("caller_not_trusted", "Issuer is registered to another coordinator UID");
    if (!previous) {
      this.db.prepare("INSERT INTO rpc_execution_coordinators VALUES(?,?)").run(issuer, uid);
      this.audit("rpc.execution.coordinator_registered", null, { issuerId: issuer, uid });
    }
    return { issuerId: issuer, uid };
  }
  requireCoordinator(issuerId: string, uid: number): void {
    const row = this.db.prepare("SELECT uid FROM rpc_execution_coordinators WHERE issuer_id=?").get(issuerId);
    if (!row || row.uid !== uid) throw new ExecutionFenceError("caller_not_trusted", "Issuer requires its registered local coordinator");
  }
  assertLegacyKey(key: string): void {
    const row = this.db.prepare("SELECT 1 FROM rpc_execution_claims WHERE json_extract(claim,'$.idempotencyKey')=? UNION ALL SELECT 1 FROM rpc_execution_effects WHERE key=? LIMIT 1").get(key, key);
    if (row) throw new ExecutionFenceError("rpc_execution_fence_unsupported", "This key requires its original execution envelope; legacy execution is refused");
  }
  private current(token: ExecutionToken): ExecutionClaim | null {
    const row = this.db.prepare("SELECT claim FROM rpc_execution_claims WHERE issuer_id=? AND continuation_id=?").get(token.issuerId, token.continuationId);
    return row ? executionClaim(JSON.parse(String(row.claim))) : null;
  }
  private covered(token: ExecutionToken): boolean { const current = this.coverage(); return token.ownerStoreId === current.ownerStoreId && token.coverageId === current.coverageId; }
  compareAndSet(value: unknown, uid: number): ExecutionClaim {
    const params = object(value, ["transitionId", "expectedClaim", "claim"]), claim = executionClaim(params.claim), transitionId = text(params.transitionId);
    this.requireCoordinator(claim.issuerId, uid);
    const request = JSON.stringify(params), prior = this.db.prepare("SELECT request,receipt FROM rpc_execution_transitions WHERE issuer_id=? AND transition_id=?").get(claim.issuerId, transitionId);
    if (prior) {
      if (!same(JSON.parse(String(prior.request)), params)) throw new ExecutionFenceError("idempotency_conflict", "Transition key was reused with different input");
      return executionClaim(JSON.parse(String(prior.receipt)));
    }
    if (!this.covered(claim)) throw new ExecutionFenceError("rpc_execution_history_unknown", "Coverage is retired; reconcile before installing a claim");
    const expected = params.expectedClaim === null ? null : executionClaim(params.expectedClaim), current = this.current(claim);
    if (!same(expected, current) || claim.generation !== (current?.generation ?? 0) + 1) throw new ExecutionFenceError("rpc_execution_stale", "Execution claim CAS failed");
    if (!claim.idempotencyKey.startsWith(`effect-v1:${claim.coverageId}:`) || !/^[a-zA-Z0-9_-]{1,128}$/.test(claim.idempotencyKey.slice(`effect-v1:${claim.coverageId}:`.length))) invalid("Execution claim requires a current covered effect key");
    if (current) {
      const { generation: oldGeneration, claimId: oldClaimId, ...immutable } = current;
      const { generation: newGeneration, claimId: newClaimId, ...proposed } = claim;
      if (!same(immutable, proposed)) throw new ExecutionFenceError("idempotency_conflict", "Claim advancement cannot change the immutable grant, resource, digest or original effect key");
      const pending = this.db.prepare("SELECT e.key,c.status FROM rpc_execution_effects e JOIN commands c ON c.id=e.command_id WHERE json_extract(e.binding,'$.issuerId')=? AND json_extract(e.binding,'$.continuationId')=? AND json_extract(e.receipt,'$.status')='queued'").all(claim.issuerId, claim.continuationId);
      if (pending.some(row => row.status !== "queued")) throw new ExecutionFenceError("rpc_execution_busy", "An admitted archive may be executing; reconcile before advancing");
      for (const row of pending) this.refuse(String(row.key));
    }
    this.db.prepare("INSERT INTO rpc_execution_claims VALUES(?,?,?) ON CONFLICT(issuer_id,continuation_id) DO UPDATE SET claim=excluded.claim").run(claim.issuerId, claim.continuationId, JSON.stringify(claim));
    this.db.prepare("INSERT INTO rpc_execution_transitions VALUES(?,?,?,?)").run(claim.issuerId, transitionId, request, JSON.stringify(claim));
    this.audit("rpc.execution.claim_advanced", claim.resource.beeId, { transitionId, claim });
    return claim;
  }
  private row(key: string): { binding: ExecutionClaim; receipt: ExecutionReceipt } | null {
    const row = this.db.prepare("SELECT binding,receipt FROM rpc_execution_effects WHERE key=?").get(key);
    if (!row) return null;
    const bound = executionClaim(JSON.parse(String(row.binding))), receipt = JSON.parse(String(row.receipt)) as ExecutionReceipt;
    if (!["queued", "completed", "refused_stale"].includes(receipt.status) || !same(executionClaim(Object.fromEntries([...TOKEN_KEYS, ...BINDING_KEYS].map(key => [key, receipt[key as keyof ExecutionReceipt]]))), bound)) throw new ExecutionFenceError("rpc_execution_history_unknown", "Corrupt execution receipt; hold the effect");
    return { binding: bound, receipt };
  }
  prepare(request: ExecutionRequest): ExecutionReceipt | null {
    const claim = { ...request.executionFence, digestVersion: request.digestVersion, verb: request.verb, resource: request.resource, requestDigest: request.requestDigest, idempotencyKey: request.idempotencyKey }, prior = this.row(request.idempotencyKey);
    if (prior) {
      if (!same(prior.binding, claim)) throw new ExecutionFenceError(prior.binding.generation !== claim.generation || prior.binding.claimId !== claim.claimId ? "rpc_execution_stale" : "idempotency_conflict", "Effect key is bound to another immutable execution request");
      return prior.receipt;
    }
    if (!this.covered(claim)) throw new ExecutionFenceError("rpc_execution_history_unknown", "Coverage is retired; hold the effect");
    if (!same(this.current(claim), claim)) throw new ExecutionFenceError("rpc_execution_stale", "Execution claim is not current");
    return null;
  }
  refusedAdmission(request: ExecutionRequest): ExecutionReceipt {
    const claim = { ...request.executionFence, digestVersion: request.digestVersion, verb: request.verb, resource: request.resource, requestDigest: request.requestDigest, idempotencyKey: request.idempotencyKey };
    const receipt: ExecutionReceipt = { ...claim, status: "refused_stale", boundary: request.verb === "send" ? "mailbox-admission" : "lifecycle-transaction", commandId: null, result: null };
    const id = canonicalDigest(claim as unknown as JsonValue);
    const previous = this.db.prepare("SELECT receipt FROM rpc_execution_refusals WHERE digest=?").get(id);
    if (previous) return JSON.parse(String(previous.receipt)) as ExecutionReceipt;
    this.db.prepare("INSERT INTO rpc_execution_refusals VALUES(?,?)").run(id, JSON.stringify(receipt));
    this.audit("rpc.execution.refused_stale", request.resource.beeId, { executionReceipt: receipt, disposition: "refused_before_admission" });
    return receipt;
  }
  record(request: ExecutionRequest, commandId: number | null, result: unknown): ExecutionReceipt {
    const claim = { ...request.executionFence, digestVersion: request.digestVersion, verb: request.verb, resource: request.resource, requestDigest: request.requestDigest, idempotencyKey: request.idempotencyKey };
    const receipt: ExecutionReceipt = { ...claim, status: request.verb === "send" ? "completed" : "queued", boundary: request.verb === "send" ? "mailbox-admission" : "lifecycle-transaction", commandId, result };
    this.db.prepare("INSERT INTO rpc_execution_effects VALUES(?,?,?,?)").run(request.idempotencyKey, JSON.stringify(claim), JSON.stringify(receipt), request.verb === "archive" ? commandId : null);
    this.audit("rpc.execution.admitted", request.resource.beeId, { receipt });
    return receipt;
  }
  commandAllowed(commandId: number): boolean {
    const row = this.db.prepare("SELECT key FROM rpc_execution_effects WHERE command_id=?").get(commandId);
    if (!row) return true;
    const effect = this.row(String(row.key))!;
    if (effect.receipt.status === "completed") return true;
    if (effect.receipt.status === "refused_stale") return false;
    if (!this.covered(effect.binding) || !same(this.current(effect.binding), effect.binding)) { this.refuse(String(row.key)); return false; }
    return true;
  }
  completed(commandId: number): void {
    const row = this.db.prepare("SELECT key FROM rpc_execution_effects WHERE command_id=?").get(commandId);
    if (!row) return;
    const effect = this.row(String(row.key))!;
    if (effect.receipt.status !== "queued") return;
    this.db.prepare("UPDATE rpc_execution_effects SET receipt=? WHERE key=?").run(JSON.stringify({ ...effect.receipt, status: "completed" }), row.key);
    this.audit("rpc.execution.completed", effect.binding.resource.beeId, { idempotencyKey: row.key, commandId });
  }
  private refuse(key: string): void {
    const effect = this.row(key)!;
    if (effect.receipt.status !== "queued") return;
    this.db.prepare("UPDATE rpc_execution_effects SET receipt=? WHERE key=?").run(JSON.stringify({ ...effect.receipt, status: "refused_stale" }), key);
    this.db.prepare("UPDATE commands SET status='done',finished_at=? WHERE id=? AND status IN ('queued','running')").run(this.now(), effect.receipt.commandId);
    this.audit("rpc.execution.refused_stale", effect.binding.resource.beeId, { idempotencyKey: key, commandId: effect.receipt.commandId, disposition: "settled_noop", executionReceipt: "refused_stale" });
  }
}
