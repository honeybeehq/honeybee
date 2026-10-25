import {processIdentityValue, type RuntimeProcessIdentity} from "./processIdentity.ts";

export interface LegacyStopRelease extends RuntimeProcessIdentity {
  generation: number;
  pidStartedAt: number;
  uid: number;
  authorityRef: string;
}

export function legacyStopRelease(value: unknown): LegacyStopRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "authorityRef,birth,bootId,generation,pid,pidStartedAt,uid") return null;
  const identity = processIdentityValue({pid: v.pid, birth: v.birth, bootId: v.bootId});
  if (!identity || !identity.birth.startsWith("linux:") || !Number.isSafeInteger(v.generation) || Number(v.generation) < 1
    || !Number.isSafeInteger(v.pidStartedAt) || Number(v.pidStartedAt) < 1 || !Number.isSafeInteger(v.uid) || Number(v.uid) < 0
    || typeof v.authorityRef !== "string" || !v.authorityRef.trim() || v.authorityRef.length > 500) return null;
  return {...identity, generation: Number(v.generation), pidStartedAt: Number(v.pidStartedAt), uid: Number(v.uid), authorityRef: v.authorityRef};
}
