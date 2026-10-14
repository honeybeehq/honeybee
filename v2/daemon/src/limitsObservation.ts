import type { AccountRow, LimitsObserverProvenance } from "../../core/src/index.ts";
import { CoreStore, isAccountId, parseMuseUsage } from "../../core/src/index.ts";
import { RpcError } from "./protocol.ts";

export const OBSERVATION_CODECS = new Map<string, {parseLocal: (usage: Record<string, unknown>) => ReturnType<typeof parseMuseUsage>}>([["muse", {parseLocal:parseMuseUsage}]]);
export const OBSERVATION_HARNESSES: ReadonlySet<string> = new Set(OBSERVATION_CODECS.keys());
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const invalid = () => new RpcError("invalid_request", "Invalid limits observation payload.");
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
};
const safe = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export function observationText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw invalid();
  return value;
}
export function assertObservationAccount(account: AccountRow, harness?: string): void {
  const refuse = (reason: string): never => { throw new RpcError("account_limits_observation_refused", "Limits observation refused for this account.", {account: account.id, reason}); };
  if (!OBSERVATION_HARNESSES.has(account.harness)) refuse("unsupported_harness");
  if (harness !== undefined && account.harness !== harness) refuse("harness_mismatch");
  if (account.source !== "local" || account.native) refuse("not_authority");
}
export function readObservation(store: CoreStore, id: string) {
  const account = store.getAccount(id);
  if (!account) throw new RpcError("account_not_found", "Account not found.");
  if (!OBSERVATION_HARNESSES.has(account.harness)) throw new RpcError("account_limits_observation_refused", "Harness has no observed limits source.", {account:id,reason:"unsupported_harness"});
  const metadata = store.getAccountObservation(id);
  const limits = store.getAccountLimits(id);
  return {account:id, selected:limits ? {limits, provenance:metadata.provenance,source:metadata.source} : null, lastLocal:metadata.lastLocal, highWatermarkMs:metadata.highWatermarkMs};
}
export function applyObservation(store: CoreStore, params: Record<string, unknown>, id: string) {
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > 4096) throw invalid();
  keys(params,["id","harness","observedAtMs","observation","provenance"]);
  if (params.id !== id) throw invalid();
  if (!safe(params.harness) || !timestamp(params.observedAtMs)) throw invalid();
  const at = params.observedAtMs;
  const observation = object(params.observation);
  keys(observation,["fiveHour","weekly","tier","source"]);
  const window = (value: unknown) => {
    if (value === undefined || value === null) return null;
    const w = object(value);keys(w,["usedPercent","resetsAtMs","windowMinutes"]);
    if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0) throw invalid();
    if (w.resetsAtMs != null && !timestamp(w.resetsAtMs)) throw invalid();
    if (w.windowMinutes != null && (typeof w.windowMinutes !== "number" || !Number.isFinite(w.windowMinutes) || w.windowMinutes <= 0)) throw invalid();
    return {usedPercent:w.usedPercent,resetsAt:w.resetsAtMs as number | null | undefined,windowMinutes:w.windowMinutes as number | null | undefined};
  };
  const fiveHour=window(observation.fiveHour), weekly=window(observation.weekly);
  if (!fiveHour && !weekly) throw invalid();
  const plan=observationText(observation.tier), source=observationText(observation.source);
  let provenance: LimitsObserverProvenance;
  let expiry: unknown[];
  try {
  const p=object(params.provenance);keys(p,["observerNodeId","currentHolder","path"]);
  if (!safe(p.observerNodeId)) throw invalid();
  if (p.currentHolder !== true) throw new RpcError("account_limits_observation_refused", "A current-holder assertion is required.", {account:id,reason:"holder_assertion_required"});
  const path=object(p.path);
  if (path.kind === "direct") keys(path,["kind","holderExpiresAtMs"]);
  else if (path.kind === "peer") keys(path,["kind","shareId","epoch","holderExpiresAtMs"]);
  else if (path.kind === "one_hop") keys(path,["kind","viaNodeId","shareId","epoch","observerExpiresAtMs","viaExpiresAtMs"]);
  else throw invalid();
  if (path.kind !== "direct" && (!safe(path.shareId) || !timestamp(path.epoch))) throw invalid();
  if (path.kind === "one_hop" && !safe(path.viaNodeId)) throw invalid();
  expiry = path.kind === "one_hop" ? [path.observerExpiresAtMs,path.viaExpiresAtMs] : [path.holderExpiresAtMs];
  if (!expiry.every(timestamp)) throw invalid();
  provenance=p as unknown as LimitsObserverProvenance;
  } catch (error) {
    if (error instanceof RpcError && error.code === "invalid_request") throw new RpcError("account_limits_observation_refused", "A complete current-holder assertion and path are required.", {account:id,reason:"holder_assertion_required"});
    throw error;
  }
  const applied=store.observeAccountLimits(id,{readable:true,fetchedAt:at,plan,fiveHour,weekly},source,provenance,(account,now)=>{
    assertObservationAccount(account,params.harness as string);
    if (at > now+300_000) throw new RpcError("account_limits_observation_refused", "Observation is too far in the future.", {account:id,reason:"future_observation"});
    if (expiry.some(value => Number(value) <= now || Number(value) < at)) throw new RpcError("account_limits_observation_refused", "Holder assertion has expired.", {account:id,reason:"expired_holder"});
  });
  const result=readObservation(store,id);
  return {account:id,applied,observedAtMs:result.selected?.limits.fetchedAt ?? null,provenance:result.selected?.provenance ?? null};
}
export function discardObservation(store: CoreStore, params: Record<string,unknown>, id: string) {
  keys(params,["id","expectedObservedAtMs"]);
  if (!timestamp(params.expectedObservedAtMs)) throw invalid();
  const discarded=store.discardAccountObservation(id,params.expectedObservedAtMs,account=>assertObservationAccount(account));
  return {...readObservation(store,id),discarded};
}

export function observationReadRequest(store: CoreStore, params: Record<string, unknown>) {
  keys(params,["id"]);
  if (params.id === undefined) return {harnesses:[...OBSERVATION_HARNESSES]};
  if (!isAccountId(params.id)) throw invalid();
  return readObservation(store,params.id);
}
