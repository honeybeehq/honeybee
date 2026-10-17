import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { canonicalDigest, type JsonValue } from "../../../src/comb/canonical.ts";
import { ExecutionFenceError, executionClaim, type ExecutionClaim } from "./executionFence.ts";

export interface ExecutionStart {
  intentId: string;
  beeId: string;
  runtimeGeneration: number;
  claim: ExecutionClaim;
}
export interface ExecutionProcess { pid: number; birth: string }
export interface ExecutionRuntimeHooks {
  check(start: ExecutionStart, operation: string): void;
  begin(start: ExecutionStart, operation: string): string;
  finish(start: ExecutionStart, lease: string, quiescent: boolean): void;
  dispatch(start: ExecutionStart): void;
  bindAndRelease(start: ExecutionStart, host: ExecutionProcess): void;
  started(start: ExecutionStart, host: ExecutionProcess, agent: ExecutionProcess): void;
  hostExited(start: ExecutionStart, host: ExecutionProcess | null): void;
}
export type ExecutionStartState = "prepared" | "dispatching" | "release_committed" | "started" | "host_exited" | "refused_stale" | "outcome_unknown";
export class ExecutionStarts {
  private readonly db: DatabaseSync;
  private readonly validate: (claim: ExecutionClaim) => void;
  private readonly audit: (kind: string, beeId: string, data: Record<string, unknown>) => void;
  private readonly complete: (key: string) => void;
  private readonly unknown: (key: string) => void;
  constructor(db: DatabaseSync, validate: (claim: ExecutionClaim) => void, audit: (kind: string, beeId: string, data: Record<string, unknown>) => void, complete: (key: string) => void, unknown: (key: string) => void) {
    this.db = db; this.validate = validate; this.audit = audit; this.complete = complete; this.unknown = unknown;
  }
  open(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS rpc_execution_bees (bee_id TEXT PRIMARY KEY, binding TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS rpc_execution_starts (intent_id TEXT PRIMARY KEY, bee_id TEXT NOT NULL, runtime_generation INTEGER NOT NULL, context TEXT NOT NULL, state TEXT NOT NULL, host TEXT, agent TEXT, UNIQUE(bee_id,runtime_generation)) STRICT; CREATE TABLE IF NOT EXISTS rpc_execution_start_ops (lease_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, operation TEXT NOT NULL, state TEXT NOT NULL) STRICT");
  }
  bindBee(claim: ExecutionClaim): void {
    const previous = this.bee(claim.resource.beeId);
    if (previous && canonicalDigest(previous as unknown as JsonValue) !== canonicalDigest(claim as unknown as JsonValue)) throw new ExecutionFenceError("idempotency_conflict", "Bee already belongs to another execution binding");
    this.db.prepare("INSERT INTO rpc_execution_bees VALUES(?,?) ON CONFLICT(bee_id) DO NOTHING").run(claim.resource.beeId, JSON.stringify(claim));
  }
  bee(beeId: string): ExecutionClaim | null {
    const row = this.db.prepare("SELECT binding FROM rpc_execution_bees WHERE bee_id=?").get(beeId);
    return row ? executionClaim(JSON.parse(String(row.binding))) : null;
  }
  existing(beeId: string, runtimeGeneration: number): ExecutionStart | null {
    if (!this.bee(beeId)) return null;
    const row = this.db.prepare("SELECT context FROM rpc_execution_starts WHERE bee_id=? AND runtime_generation=?").get(beeId,runtimeGeneration);
    if (!row) throw new ExecutionFenceError("rpc_execution_history_unknown", "Fenced runtime has no original durable start intent");
    return this.context(JSON.parse(String(row.context)));
  }
  host(start: ExecutionStart): ExecutionProcess | null {
    const row = this.row(start);
    if (row.host === null) return null;
    const host = JSON.parse(String(row.host)) as ExecutionProcess; this.process(host); return host;
  }
  prepare(beeId: string, runtimeGeneration: number): ExecutionStart | null {
    const claim = this.bee(beeId); if (!claim) return null;
    this.validate(claim);
    const row = this.db.prepare("SELECT context,state FROM rpc_execution_starts WHERE bee_id=? AND runtime_generation=?").get(beeId, runtimeGeneration);
    if (row) {
      const start = this.context(JSON.parse(String(row.context)));
      if (row.state !== "prepared") throw new ExecutionFenceError("rpc_execution_history_unknown", "Original start attempt already dispatched or settled; reconcile instead of restarting");
      return start;
    }
    const previous = this.db.prepare("SELECT 1 FROM rpc_execution_starts WHERE bee_id=?").get(beeId);
    if (previous) throw new ExecutionFenceError("rpc_execution_history_unknown", "A fenced bee cannot silently restart under its old spawn grant");
    const start: ExecutionStart = { intentId: randomUUID(), beeId, runtimeGeneration, claim };
    this.db.prepare("INSERT INTO rpc_execution_starts VALUES(?,?,?,?, 'prepared',NULL,NULL)").run(start.intentId, beeId, runtimeGeneration, JSON.stringify(start));
    this.audit("rpc.execution.start_intent", beeId, { start });
    return start;
  }
  private context(value: unknown): ExecutionStart {
    if (!value || typeof value !== "object") throw new ExecutionFenceError("rpc_execution_history_unknown", "Missing start intent context");
    const v = value as ExecutionStart;
    if (Object.keys(v).sort().join(",") !== "beeId,claim,intentId,runtimeGeneration" || typeof v.intentId !== "string" || !Number.isSafeInteger(v.runtimeGeneration) || v.runtimeGeneration < 1 || executionClaim(v.claim).resource.beeId !== v.beeId) throw new ExecutionFenceError("rpc_execution_history_unknown", "Corrupt start intent context");
    return v;
  }
  private row(start: ExecutionStart) {
    this.context(start);
    const row = this.db.prepare("SELECT * FROM rpc_execution_starts WHERE intent_id=?").get(start.intentId);
    if (!row || canonicalDigest(JSON.parse(String(row.context))) !== canonicalDigest(start as unknown as JsonValue)) throw new ExecutionFenceError("rpc_execution_history_unknown", "Start intent binding differs from durable authority");
    if (!["prepared","dispatching","release_committed","started","host_exited","refused_stale","outcome_unknown"].includes(String(row.state))) throw new ExecutionFenceError("rpc_execution_history_unknown", "Unknown start intent state");
    return row;
  }
  check(start: ExecutionStart, operation: string): void {
    const row = this.row(start); this.validate(start.claim);
    if (this.db.prepare("SELECT 1 FROM rpc_execution_start_ops WHERE intent_id=? AND state='unknown'").get(start.intentId)) throw new ExecutionFenceError("rpc_execution_history_unknown", "Prior preparation descendants are unknown");
    if (row.state !== "prepared") throw new ExecutionFenceError("rpc_execution_history_unknown", "Start preparation is no longer admissible");
    this.audit("rpc.execution.preparation_checked", start.beeId, { intentId: start.intentId, operation });
  }
  begin(start: ExecutionStart, operation: string): string {
    this.check(start, operation);
    if (this.db.prepare("SELECT 1 FROM rpc_execution_start_ops WHERE intent_id=? AND state!='quiescent'").get(start.intentId)) throw new ExecutionFenceError("rpc_execution_busy", "Another preparation operation is still active");
    const lease = randomUUID();
    this.db.prepare("INSERT INTO rpc_execution_start_ops VALUES(?,?,?,'active')").run(lease, start.intentId, operation);
    return lease;
  }
  finish(start: ExecutionStart, lease: string, quiescent: boolean): void {
    this.row(start);
    const row = this.db.prepare("SELECT intent_id,state FROM rpc_execution_start_ops WHERE lease_id=?").get(lease);
    if (!row || row.intent_id !== start.intentId) throw new ExecutionFenceError("rpc_execution_history_unknown", "Unknown preparation lease");
    if (row.state === "quiescent") return;
    this.db.prepare("UPDATE rpc_execution_start_ops SET state=? WHERE lease_id=?").run(quiescent ? "quiescent" : "unknown", lease);
    this.audit("rpc.execution.preparation_settled", start.beeId, { intentId: start.intentId, lease, quiescent });
  }
  dispatch(start: ExecutionStart): void {
    this.check(start, "host_dispatch");
    if (this.db.prepare("SELECT 1 FROM rpc_execution_start_ops WHERE intent_id=? AND state!='quiescent'").get(start.intentId)) throw new ExecutionFenceError("rpc_execution_busy", "Preparation is not proven quiescent");
    this.db.prepare("UPDATE rpc_execution_starts SET state='dispatching' WHERE intent_id=?").run(start.intentId);
    this.audit("rpc.execution.host_dispatch_intent", start.beeId, { intentId: start.intentId });
  }
  bindAndRelease(start: ExecutionStart, host: ExecutionProcess): void {
    const row = this.row(start); this.validate(start.claim); this.process(host);
    if (row.state === "release_committed") {
      if (String(row.host) !== JSON.stringify(host)) throw new ExecutionFenceError("rpc_execution_history_unknown", "Release belongs to another host identity");
      return;
    }
    if (row.state !== "dispatching") throw new ExecutionFenceError("rpc_execution_stale", "Host release is no longer permitted");
    this.db.prepare("UPDATE rpc_execution_starts SET state='release_committed',host=? WHERE intent_id=?").run(JSON.stringify(host), start.intentId);
    this.audit("rpc.execution.host_release_committed", start.beeId, { intentId: start.intentId, host });
  }
  started(start: ExecutionStart, host: ExecutionProcess, agent: ExecutionProcess): void {
    const row = this.row(start); this.process(host); this.process(agent);
    if (row.state === "started" && String(row.host) === JSON.stringify(host) && String(row.agent) === JSON.stringify(agent)) return;
    if (row.state !== "release_committed" || String(row.host) !== JSON.stringify(host)) throw new ExecutionFenceError("rpc_execution_history_unknown", "Agent acknowledgement lacks its exact committed host release");
    this.db.prepare("UPDATE rpc_execution_starts SET state='started',agent=? WHERE intent_id=?").run(JSON.stringify(agent), start.intentId);
    this.complete(start.claim.idempotencyKey);
    this.audit("rpc.execution.agent_started", start.beeId, { intentId: start.intentId, host, agent });
  }
  hostExited(start: ExecutionStart, host: ExecutionProcess | null): void {
    const row = this.row(start);
    if (row.state === "started") return;
    if (row.state === "release_committed" || row.state === "outcome_unknown" || host === null || row.host !== null && String(row.host) !== JSON.stringify(host)) {
      this.db.prepare("UPDATE rpc_execution_starts SET state='outcome_unknown' WHERE intent_id=?").run(start.intentId);
      this.unknown(start.claim.idempotencyKey);
      this.audit("rpc.execution.start_outcome_unknown", start.beeId, { intentId: start.intentId, host });
      return;
    }
    this.db.prepare("UPDATE rpc_execution_starts SET state='host_exited',host=? WHERE intent_id=?").run(JSON.stringify(host), start.intentId);
    this.audit("rpc.execution.host_exited", start.beeId, { intentId: start.intentId, host, disposition: "no_new_fork" });
  }
  assertAdvance(claim: ExecutionClaim): void {
    const rows = this.db.prepare("SELECT * FROM rpc_execution_starts WHERE json_extract(context,'$.claim.issuerId')=? AND json_extract(context,'$.claim.continuationId')=?").all(claim.issuerId, claim.continuationId);
    for (const row of rows) {
      if (this.db.prepare("SELECT 1 FROM rpc_execution_start_ops WHERE intent_id=? AND state!='quiescent'").get(String(row.intent_id))) throw new ExecutionFenceError("rpc_execution_busy", "Preparation worker or descendants may still mutate");
      if (["dispatching","release_committed","outcome_unknown"].includes(String(row.state))) throw new ExecutionFenceError("rpc_execution_busy", "Released or unknown host may still fork");
    }
    for (const row of rows) if (["prepared","dispatching"].includes(String(row.state))) this.db.prepare("UPDATE rpc_execution_starts SET state='refused_stale' WHERE intent_id=?").run(String(row.intent_id));
  }
  private process(value: ExecutionProcess): void {
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !/^(?:linux:[0-9]+|darwin:[0-9]+:[0-9]+)$/.test(value.birth)) throw new ExecutionFenceError("rpc_execution_history_unknown", "Exact non-truncated process identity is required");
  }
}
