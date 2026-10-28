import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../../../src/comb/canonical.ts";
import { RpcError } from "./protocol.ts";

export const NO_SATELLITE_NOTICE = Object.freeze({ code: "no_satellite_available", message: "No satellite available; running on this computer" } as const);
export type EligibilityReason = "no_candidate" | "no_subscription" | "registration_expired" | "timeout" | "digest_mismatch" | "malformed" | "criteria_unsupported" | "queue_full";
export type SatelliteDecision = { eligible: true; satellite: { nodeId: string; name: string } } | { eligible: false; reason: EligibilityReason };
export interface PlacementFallback { notice: typeof NO_SATELLITE_NOTICE; admissionDiagnostic: { reason: EligibilityReason } }
export type EligibilityOrigin = "apiary-routed" | "unprepared";
export interface EligibilityQuery { origin: EligibilityOrigin; version: 1; queryId: string; daemonInstanceId: string; registrationEpoch: string; destinationNodeId: string; operation: string; requestDigest: string; expiresAtMs: number; fields: Record<string, string | null> }
export interface EligibilityAnswer { version: 1; queryId: string; origin?: EligibilityOrigin; daemonInstanceId: string; registrationEpoch: string; destinationNodeId: string; requestDigest: string; expiresAtMs: number; eligible: boolean; satellite?: { nodeId: string; name: string } }
export interface EligibilityRegistration { daemonInstanceId: string; registrationEpoch: string; expiresAtMs: number }
const RAW_FIELDS = ["harness", "agent", "account", "requiredCapability", "parentNodeId", "branch", "sha", "groupId", "idempotencyKey", "beeId"] as const;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024 && !v.includes("\0");
export function eligibilityFields(params: Record<string, unknown>): Record<string, string | null> | null {
  const fields: Record<string, string | null> = {};
  for (const key of RAW_FIELDS) if (params[key] !== undefined) {
    const value = params[key];
    if (value !== null && (typeof value !== "string" || value.length > 1024 || value.includes("\0"))) return null;
    if (key === "requiredCapability" && !text(value)) return null;
    fields[key] = value as string | null;
  }
  return fields;
}
export function eligibilityDigest(registration: EligibilityRegistration, destinationNodeId: string, operation: string, fields: Record<string, string | null>, origin: EligibilityOrigin = "unprepared"): string {
  return canonicalDigest({ version: 1, daemonInstanceId: registration.daemonInstanceId, registrationEpoch: registration.registrationEpoch, destinationNodeId, operation, origin, fields });
}
type Pending = { query: EligibilityQuery; finish: (decision: SatelliteDecision) => void };
type Subscription = { identity: object; nodeId: string; registration: EligibilityRegistration; current: () => boolean; expiry: ReturnType<typeof setTimeout>; poll?: { finish: (queries: EligibilityQuery[]) => void } };

/** Apiary pulls queries over its authenticated local connection. Honeybee owns no fleet facts. */
export class SatelliteEligibility {
  private subscription: Subscription | null = null;
  private readonly pending = new Map<string, Pending>();
  private queue: EligibilityQuery[] = [];
  private readonly carriedUsed = new Map<string, number>();
  private readonly attempts = new Map<string, Promise<SatelliteDecision>>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  constructor(timeoutMs = 1500, maxPending = 128) { this.timeoutMs = timeoutMs; this.maxPending = maxPending; }
  get status() { return { ready: this.subscription !== null && this.subscription.registration.expiresAtMs > Date.now(), registrationEpoch: this.subscription?.registration.registrationEpoch ?? null }; }
  private live(): Subscription | null {
    const sub = this.subscription;
    if (sub && (sub.registration.expiresAtMs <= Date.now() || !sub.current())) this.drop("registration_expired");
    return this.subscription;
  }
  disconnect(identity: object): void { if (this.subscription?.identity === identity) this.drop("no_subscription"); }
  drop(reason: EligibilityReason): void {
    const sub = this.subscription;
    this.subscription = null;
    if (sub) { clearTimeout(sub.expiry); sub.poll?.finish([]); }
    for (const p of [...this.pending.values()]) p.finish({ eligible: false, reason });
    this.queue = [];
  }
  subscribe(identity: object, nodeId: unknown, registration: EligibilityRegistration, current: () => boolean): Promise<{ queries: EligibilityQuery[] }> {
    if (!text(nodeId)) throw new RpcError("invalid_request", "A local Apiary node identity is required");
    const existing = this.live();
    if (existing && (existing.identity !== identity || existing.registration.registrationEpoch !== registration.registrationEpoch)) throw new RpcError("caller_not_trusted", "Eligibility subscription already belongs to another connection");
    if (existing?.poll) throw new RpcError("invalid_request", "Only one eligibility poll may be pending");
    if (!existing) {
      const expiry = setTimeout(() => this.drop("registration_expired"), Math.max(0, registration.expiresAtMs - Date.now()));
      expiry.unref?.();
      this.subscription = { identity, nodeId, registration, current, expiry };
    } else if (existing.nodeId !== nodeId) throw new RpcError("invalid_request", "Eligibility destination identity changed");
    return new Promise(resolve => {
      const sub = this.subscription!;
      const timer = setTimeout(() => finish([]), 30_000); timer.unref?.();
      const finish = (queries: EligibilityQuery[]) => { clearTimeout(timer); sub.poll = undefined; resolve({ queries }); };
      sub.poll = { finish };
      this.flush();
    });
  }
  private flush(): void {
    const sub = this.live();
    if (!sub?.poll) return;
    const queries = this.queue.filter(q => this.pending.has(q.queryId));
    this.queue = [];
    if (queries.length) sub.poll.finish(queries);
  }
  request(operation: string, params: Record<string, unknown>, carried?: { value: unknown; registration: EligibilityRegistration }, origin: EligibilityOrigin = "unprepared"): Promise<SatelliteDecision> {
    const fields = eligibilityFields(params);
    if (!fields) return Promise.resolve({ eligible: false, reason: "criteria_unsupported" });
    if (carried) {
      const a = carried.value as Record<string, unknown> | null;
      if (a && text(a.destinationNodeId)) {
        const digest = eligibilityDigest(carried.registration, a.destinationNodeId, operation, fields, origin);
        if (!text(a.queryId)) return Promise.resolve({ eligible: false, reason: "malformed" });
        for (const [key, expiry] of this.carriedUsed) if (expiry <= Date.now()) this.carriedUsed.delete(key);
        const token = `${carried.registration.registrationEpoch}:${a.queryId}`;
        if (this.carriedUsed.has(token)) return Promise.resolve({ eligible: false, reason: "digest_mismatch" });
        if (this.carriedUsed.size >= this.maxPending) return Promise.resolve({ eligible: false, reason: "queue_full" });
        const decision = this.parseAnswer(a, digest, a.destinationNodeId, carried.registration, origin);
        if (decision.eligible || decision.reason === "no_candidate") this.carriedUsed.set(token, a.expiresAtMs as number);
        return Promise.resolve(decision);
      }
      return Promise.resolve({ eligible: false, reason: "malformed" });
    }
    const sub = this.live();
    if (!sub) return Promise.resolve({ eligible: false, reason: "no_subscription" });
    const digest = eligibilityDigest(sub.registration, sub.nodeId, operation, fields, origin);
    const keyed = typeof fields.idempotencyKey === "string" && fields.idempotencyKey.length > 0;
    const existing = keyed ? this.attempts.get(digest) : undefined;
    if (existing) return existing;
    if (this.pending.size >= this.maxPending) return Promise.resolve({ eligible: false, reason: "queue_full" });
    const attempt = new Promise<SatelliteDecision>(resolve => {
      const query: EligibilityQuery = { origin, version: 1, queryId: randomUUID(), daemonInstanceId: sub.registration.daemonInstanceId, registrationEpoch: sub.registration.registrationEpoch, destinationNodeId: sub.nodeId, operation, fields, requestDigest: digest, expiresAtMs: Math.min(Date.now() + this.timeoutMs, sub.registration.expiresAtMs) };
      const timer = setTimeout(() => finish({ eligible: false, reason: "timeout" }), Math.max(0, query.expiresAtMs - Date.now())); timer.unref?.();
      const finish = (decision: SatelliteDecision) => { clearTimeout(timer); this.pending.delete(query.queryId); if (keyed) this.attempts.delete(digest); this.queue = this.queue.filter(q => q.queryId !== query.queryId); resolve(decision); };
      this.pending.set(query.queryId, { query, finish });
      this.queue.push(query); this.flush();
    });
    if (keyed) this.attempts.set(digest, attempt);
    return attempt;
  }
  answer(identity: object, value: Record<string, unknown>): { accepted: boolean } {
    const sub = this.live();
    if (!sub || sub.identity !== identity) throw new RpcError("caller_not_trusted", "No matching eligibility subscription");
    const p = this.pending.get(String(value.queryId));
    if (!p) return { accepted: false };
    p.finish(this.parseAnswer(value, p.query.requestDigest, p.query.destinationNodeId, sub.registration, p.query.origin));
    return { accepted: true };
  }
  private parseAnswer(a: Record<string, unknown>, digest: string, destinationNodeId: string, registration: EligibilityRegistration, origin: EligibilityOrigin): SatelliteDecision {
    if (Object.keys(a).some(k => !["origin", "version", "queryId", "daemonInstanceId", "registrationEpoch", "destinationNodeId", "requestDigest", "expiresAtMs", "eligible", "satellite"].includes(k)) || a.version !== 1 || typeof a.eligible !== "boolean") return { eligible: false, reason: "malformed" };
    if (a.daemonInstanceId !== registration.daemonInstanceId || a.registrationEpoch !== registration.registrationEpoch || a.requestDigest !== digest || a.destinationNodeId !== destinationNodeId || (a.origin !== undefined && a.origin !== origin)) return { eligible: false, reason: "digest_mismatch" };
    if (typeof a.expiresAtMs !== "number" || !Number.isSafeInteger(a.expiresAtMs) || a.expiresAtMs <= Date.now() || a.expiresAtMs > Math.min(Date.now() + this.timeoutMs, registration.expiresAtMs)) return { eligible: false, reason: "timeout" };
    if (!a.eligible) return a.satellite === undefined ? { eligible: false, reason: "no_candidate" } : { eligible: false, reason: "malformed" };
    const s = a.satellite as Record<string, unknown> | undefined;
    if (!s || Object.keys(s).some(k => k !== "nodeId" && k !== "name") || !text(s.nodeId) || !text(s.name) || s.nodeId === destinationNodeId) return { eligible: false, reason: "malformed" };
    return { eligible: true, satellite: { nodeId: s.nodeId, name: s.name } };
  }
}
