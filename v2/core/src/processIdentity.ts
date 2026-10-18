export interface RuntimeProcessIdentity {pid: number; birth: string; bootId: string}
export function processIdentityValue(value: unknown): RuntimeProcessIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "birth,bootId,pid" || !Number.isSafeInteger(v.pid) || Number(v.pid) <= 0 || typeof v.birth !== "string" || typeof v.bootId !== "string") return null;
  const darwin = /^darwin:([0-9]{1,20}):([0-9]{1,6})$/.exec(v.birth);
  const linux = /^linux:([0-9]{1,20})$/.exec(v.birth);
  if (darwin && BigInt(darwin[1]!) <= 0xffffffffffffffffn && Number(darwin[2]) < 1000000 && v.bootId === "" || linux && BigInt(linux[1]!) <= 0xffffffffffffffffn && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v.bootId)) return {pid: Number(v.pid), birth: v.birth, bootId: v.bootId};
  return null;
}
