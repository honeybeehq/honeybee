import { resolve, isAbsolute } from "node:path";
import { canonicalDigest } from "./comb/canonical.js";
import { parseComponentIdentity, type ComponentIdentity } from "./release/index.js";
import { parseUpdateReservation, type UpdateReservation } from "./updateReservation.js";

export const APIARY_SWAP_CAPABILITY = "update.reservation.apiary-swap.v1";
export type ApiaryBuild = { protocol: string; buildId: string; version: string; target: string; artifact: { url: string; sha256: string } };
export type ApiaryPair = { app: ApiaryBuild; resident: ApiaryBuild };
export type ApiarySwapTransaction = {
  version: 1; purpose: "apiary-swap";
  scope: { node: string; appRoot: string; runtimeRoot: string; storePath: string };
  previous: ApiaryPair; candidate: ApiaryPair; rollback: ApiaryPair;
  expectedHoneybeeIdentity: ComponentIdentity;
};
export type ApiarySwapResolution = { kind: "released" | "abandoned"; receiptDigest: string }
  | { kind: "recovered"; fromEpoch: number; recoveryId: string; recoveryReceiptDigest: string };
export type ApiarySwapReservation = {
  format: 2; purpose: "apiary-swap"; epoch: number; id: string; transactionDigest: string;
  expectedHoneybeeIdentity: ComponentIdentity; active: boolean; resolution?: ApiarySwapResolution;
};
export type DurableUpdateReservation = UpdateReservation | ApiarySwapReservation;
export type ApiarySwapOwner = { purpose: "apiary-swap"; id: string; epoch: number; transactionDigest: string; expectedHoneybeeIdentity: ComponentIdentity };
export type ApiarySwapAcquire = Omit<ApiarySwapOwner, "epoch"> & { expectedEpoch: number; transaction: ApiarySwapTransaction };
export type ApiarySwapReceipt = ApiarySwapOwner & { version: 1; journalDigest: string }
  & ({ outcome: "succeeded" | "rolled-back"; policy: "restored" }
    | { outcome: "abandoned"; phase: "acquired"; policy: "unchanged" }
    | { outcome: "recovered"; policy: "restored"; coordinator: "fenced"; generations: "reconciled" });
export type ApiarySwapSettle = ApiarySwapOwner & { receipt: ApiarySwapReceipt };
export type ApiarySwapRecover = Omit<ApiarySwapOwner, "epoch"> & { expectedEpoch: number; recoveryId: string; receipt: ApiarySwapReceipt };
export class ApiarySwapError extends Error {
  readonly code: "invalid_request" | "reservation_mismatch" | "epoch_changed" | "recovery_needed";
  constructor(code: ApiarySwapError["code"], message: string) { super(`apiary-swap: ${message}`); this.name = "ApiarySwapError"; this.code = code; }
}
function invalid(message: string): never { throw new ApiarySwapError("invalid_request", message); }
function shape(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("expected an object");
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (keys.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))) invalid("unknown or missing fields");
  return record;
}
function text(value: unknown): string { if (typeof value !== "string" || !value || value.length > 4096) invalid("invalid text"); return value; }
function id(value: unknown): string { const result = text(value); if (!/^[a-zA-Z0-9_-]{1,128}$/.test(result)) invalid("invalid id"); return result; }
function digest(value: unknown): string { const result = text(value); if (!/^sha256:[a-f0-9]{64}$/.test(result)) invalid("invalid digest"); return result; }
function epoch(value: unknown, minimum = 1): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid("invalid epoch"); return value; }
function path(value: unknown): string { const result = text(value); if (!isAbsolute(result) || resolve(result) !== result) invalid("noncanonical scope path"); return result; }
function identity(value: unknown): ComponentIdentity {
  const r = shape(value, ["component", "version", "sourceRevision", "target", "artifact"]);
  shape(r.artifact, ["url", "sha256"]);
  try {
    const parsed = parseComponentIdentity(r);
    if (parsed.component !== "honeybee") invalid("expected Honeybee identity");
    return parsed;
  } catch { return invalid("invalid Honeybee identity"); }
}
function build(value: unknown): ApiaryBuild {
  const r = shape(value, ["protocol", "buildId", "version", "target", "artifact"]);
  const artifact = shape(r.artifact, ["url", "sha256"]);
  const url = text(artifact.url), sha256 = digest(artifact.sha256);
  if (!URL.canParse(url) || new URL(url).protocol !== "https:") invalid("invalid Apiary artifact");
  return { protocol: text(r.protocol), buildId: text(r.buildId), version: text(r.version), target: text(r.target), artifact: { url, sha256 } };
}
function pair(value: unknown): ApiaryPair { const r = shape(value, ["app", "resident"]); return { app: build(r.app), resident: build(r.resident) }; }
function owner(value: Record<string, unknown>): ApiarySwapOwner {
  if (value.purpose !== "apiary-swap") invalid("unknown purpose");
  return { purpose: "apiary-swap", id: id(value.id), epoch: epoch(value.epoch), transactionDigest: digest(value.transactionDigest), expectedHoneybeeIdentity: identity(value.expectedHoneybeeIdentity) };
}
const OWNER_KEYS = ["purpose", "id", "epoch", "transactionDigest", "expectedHoneybeeIdentity"];
function sameOwner(a: ApiarySwapOwner, b: ApiarySwapOwner): boolean { return a.purpose === b.purpose && a.id === b.id && a.epoch === b.epoch && a.transactionDigest === b.transactionDigest && canonicalDigest(a.expectedHoneybeeIdentity) === canonicalDigest(b.expectedHoneybeeIdentity); }
export function parseApiarySwapTransaction(value: unknown): ApiarySwapTransaction {
  const r = shape(value, ["version", "purpose", "scope", "previous", "candidate", "rollback", "expectedHoneybeeIdentity"]);
  if (r.version !== 1 || r.purpose !== "apiary-swap") invalid("unknown transaction version or purpose");
  const scope = shape(r.scope, ["node", "appRoot", "runtimeRoot", "storePath"]);
  const transaction: ApiarySwapTransaction = { version: 1, purpose: "apiary-swap", scope: { node: text(scope.node), appRoot: path(scope.appRoot), runtimeRoot: path(scope.runtimeRoot), storePath: path(scope.storePath) }, previous: pair(r.previous), candidate: pair(r.candidate), rollback: pair(r.rollback), expectedHoneybeeIdentity: identity(r.expectedHoneybeeIdentity) };
  if ([transaction.previous, transaction.candidate].some(generation => generation.app.target !== transaction.expectedHoneybeeIdentity.target || generation.resident.target !== transaction.expectedHoneybeeIdentity.target)) invalid("transaction target differs from pinned Honeybee");
  if (canonicalDigest(transaction.rollback) !== canonicalDigest(transaction.previous)) invalid("rollback must name the exact previous generation");
  return transaction;
}
export function parseApiarySwapAcquire(value: unknown): ApiarySwapAcquire {
  const r = shape(value, ["purpose", "id", "expectedEpoch", "transactionDigest", "expectedHoneybeeIdentity", "transaction"]);
  const token = owner({ ...r, epoch: 1 });
  const transaction = parseApiarySwapTransaction(r.transaction);
  if (canonicalDigest(transaction) !== token.transactionDigest || canonicalDigest(transaction.expectedHoneybeeIdentity) !== canonicalDigest(token.expectedHoneybeeIdentity)) invalid("transaction digest or identity mismatch");
  const { epoch: unused, ...fields } = token;
  return { ...fields, expectedEpoch: epoch(r.expectedEpoch, 0), transaction };
}
function receipt(value: unknown): ApiarySwapReceipt {
  const r = shape(value, [...OWNER_KEYS, "version", "journalDigest", "outcome", "policy"], ["phase", "coordinator", "generations"]);
  if (r.version !== 1) invalid("unknown receipt version");
  const base = { ...owner(r), version: 1 as const, journalDigest: digest(r.journalDigest) };
  if ((r.outcome === "succeeded" || r.outcome === "rolled-back") && r.policy === "restored") {
    shape(r, [...OWNER_KEYS, "version", "journalDigest", "outcome", "policy"]);
    return { ...base, outcome: r.outcome, policy: "restored" };
  }
  if (r.outcome === "abandoned" && r.phase === "acquired" && r.policy === "unchanged") {
    shape(r, [...OWNER_KEYS, "version", "journalDigest", "outcome", "policy", "phase"]);
    return { ...base, outcome: "abandoned", phase: "acquired", policy: "unchanged" };
  }
  if (r.outcome === "recovered" && r.policy === "restored" && r.coordinator === "fenced" && r.generations === "reconciled") {
    shape(r, [...OWNER_KEYS, "version", "journalDigest", "outcome", "policy", "coordinator", "generations"]);
    return { ...base, outcome: "recovered", policy: "restored", coordinator: "fenced", generations: "reconciled" };
  }
  return invalid("incomplete owner receipt; recovery needed");
}
export function parseApiarySwapSettle(value: unknown, kind: "release" | "abandon"): ApiarySwapSettle {
  const key = kind === "release" ? "completionReceipt" : "cancellationReceipt";
  const r = shape(value, [...OWNER_KEYS, key]), token = owner(r), parsed = receipt(r[key]);
  if (!sameOwner(token, parsed) || (kind === "release" ? !["succeeded", "rolled-back"].includes(parsed.outcome) : parsed.outcome !== "abandoned")) invalid("receipt does not bind this operation and owner");
  return { ...token, receipt: parsed };
}
export function parseApiarySwapRecover(value: unknown): ApiarySwapRecover {
  const r = shape(value, ["purpose", "id", "expectedEpoch", "transactionDigest", "expectedHoneybeeIdentity", "recoveryId", "recoveryReceipt"]);
  const token = owner({ ...r, epoch: r.expectedEpoch }), parsed = receipt(r.recoveryReceipt);
  if (!sameOwner(token, parsed) || parsed.outcome !== "recovered") invalid("recovery receipt does not bind held owner");
  const { epoch: heldEpoch, ...fields } = token;
  return { ...fields, expectedEpoch: heldEpoch, recoveryId: id(r.recoveryId), receipt: parsed };
}
export function parseApiarySwapReservation(value: unknown): ApiarySwapReservation {
  const r = shape(value, ["format", ...OWNER_KEYS, "active"], ["resolution"]);
  if (r.format !== 2 || typeof r.active !== "boolean") invalid("unknown reservation format");
  const result: ApiarySwapReservation = { format: 2, ...owner(r), active: r.active };
  if (result.active) { if (r.resolution !== undefined) invalid("active owner has a resolution"); return result; }
  const resolution = shape(r.resolution, ["kind"], ["receiptDigest", "fromEpoch", "recoveryId", "recoveryReceiptDigest"]);
  if (resolution.kind === "released" || resolution.kind === "abandoned") {
    shape(resolution, ["kind", "receiptDigest"]);
    result.resolution = { kind: resolution.kind, receiptDigest: digest(resolution.receiptDigest) };
  } else if (resolution.kind === "recovered") {
    shape(resolution, ["kind", "fromEpoch", "recoveryId", "recoveryReceiptDigest"]);
    const fromEpoch = epoch(resolution.fromEpoch);
    if (result.epoch !== fromEpoch + 1) invalid("invalid recovery fence");
    result.resolution = { kind: "recovered", fromEpoch, recoveryId: id(resolution.recoveryId), recoveryReceiptDigest: digest(resolution.recoveryReceiptDigest) };
  } else invalid("unknown resolution");
  return result;
}
export function isApiarySwap(value: DurableUpdateReservation): value is ApiarySwapReservation { return "purpose" in value && value.purpose === "apiary-swap"; }
export function parseDurableUpdateReservation(value: unknown): DurableUpdateReservation {
  if (typeof value === "object" && value !== null && ("format" in value || "purpose" in value)) return parseApiarySwapReservation(value);
  shape(value, ["epoch", "id", "recoverySubjectDigest", "active"]);
  return parseUpdateReservation(value);
}
export function acquireApiarySwap(previous: DurableUpdateReservation, input: ApiarySwapAcquire): ApiarySwapReservation {
  const token: ApiarySwapOwner = { purpose: input.purpose, id: input.id, epoch: input.expectedEpoch + 1, transactionDigest: input.transactionDigest, expectedHoneybeeIdentity: input.expectedHoneybeeIdentity };
  if (isApiarySwap(previous) && previous.active && sameOwner(previous, { ...token }) && previous.epoch === token.epoch) return previous;
  if (previous.epoch !== input.expectedEpoch) throw new ApiarySwapError("epoch_changed", "reservation epoch changed");
  if (previous.active) throw new ApiarySwapError("reservation_mismatch", "another coordinated update is reserved");
  epoch(token.epoch);
  return { format: 2, ...token, active: true };
}
export function settleApiarySwap(previous: DurableUpdateReservation, input: ApiarySwapSettle, kind: "release" | "abandon"): ApiarySwapReservation {
  if (!isApiarySwap(previous) || !sameOwner({ purpose: previous.purpose, id: previous.id, epoch: previous.epoch, transactionDigest: previous.transactionDigest, expectedHoneybeeIdentity: previous.expectedHoneybeeIdentity }, input)) throw new ApiarySwapError("reservation_mismatch", "reservation owner mismatch");
  const resolution: ApiarySwapResolution = { kind: kind === "release" ? "released" : "abandoned", receiptDigest: canonicalDigest(input.receipt) };
  if (!previous.active) {
    if (canonicalDigest(previous.resolution ?? null) !== canonicalDigest(resolution)) throw new ApiarySwapError("reservation_mismatch", "resolution differs");
    return previous;
  }
  return { ...previous, active: false, resolution };
}
export function recoverApiarySwap(previous: DurableUpdateReservation, input: ApiarySwapRecover): ApiarySwapReservation {
  if (!isApiarySwap(previous)) throw new ApiarySwapError("reservation_mismatch", "not an Apiary owner");
  const token = { purpose: previous.purpose, id: previous.id, epoch: previous.epoch, transactionDigest: previous.transactionDigest, expectedHoneybeeIdentity: previous.expectedHoneybeeIdentity };
  const requested = { purpose: input.purpose, id: input.id, epoch: input.expectedEpoch, transactionDigest: input.transactionDigest, expectedHoneybeeIdentity: input.expectedHoneybeeIdentity };
  const resolution: ApiarySwapResolution = { kind: "recovered", fromEpoch: input.expectedEpoch, recoveryId: input.recoveryId, recoveryReceiptDigest: canonicalDigest(input.receipt) };
  if (!previous.active && previous.epoch === input.expectedEpoch + 1 && sameOwner({ ...token, epoch: input.expectedEpoch }, requested) && canonicalDigest(previous.resolution ?? null) === canonicalDigest(resolution)) return previous;
  if (!previous.active || !sameOwner(token, requested)) throw new ApiarySwapError("reservation_mismatch", "recovery owner mismatch");
  return { ...previous, epoch: epoch(previous.epoch + 1), active: false, resolution };
}
