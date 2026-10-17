import { CoreError, type AccountRow, type AccountLeaseOrigin } from "./types.ts";

export const LEASE_UNKNOWN_MESSAGE = "lease record unreadable; re-lease or repair before it can take work";
export type AccountLeaseRead = Pick<AccountRow, "leasedFrom">;

export function accountLeaseUnknown(account: Pick<AccountRow, "leasedFrom">): boolean {
  return account.leasedFrom !== null && (typeof account.leasedFrom !== "object" || "kind" in account.leasedFrom);
}

export class AccountLeaseUnknownError extends CoreError {
  readonly code = "account_unavailable";
  readonly reason = "lease_unknown";
  constructor() { super(LEASE_UNKNOWN_MESSAGE); }
}

export function knownAccountLease(account: Pick<AccountRow, "leasedFrom"> | null | undefined): AccountLeaseOrigin | null {
  const origin = account?.leasedFrom ?? null;
  if (origin && "kind" in origin) throw new AccountLeaseUnknownError();
  return origin;
}

export function presentAccountLease(account: AccountRow): Omit<AccountRow, "leasedFrom"> & { leasedFrom: AccountLeaseOrigin | null } {
  return accountLeaseUnknown(account)
    ? { ...account, source: "leased", leasedFrom: null, status: "paused", pausedBy: "lease", pausedOwner: null, pausedAt: account.updatedAt, statusReason: LEASE_UNKNOWN_MESSAGE }
    : { ...account, leasedFrom: knownAccountLease(account) };
}

export function readAccountLease(raw: unknown, source: unknown): AccountLeaseRead {
  if (raw === null || raw === undefined) return source === "leased" ? { leasedFrom: { kind: "unknown" } } : { leasedFrom: null };
  const unknown: AccountLeaseRead = { leasedFrom: { kind: "unknown" } };
  let value: unknown;
  try { value = JSON.parse(String(raw)); } catch { return unknown; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unknown;
  const row = value as Record<string, unknown>;
  const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const time = (v: unknown) => v === null || typeof v === "number" && Number.isFinite(v) && v >= 0;
  const text = (v: unknown) => typeof v === "string" && v.length > 0;
  const revokedAt = Object.hasOwn(row, "revokedAt") ? row.revokedAt : row.endedAt;
  if (!text(row.shareId) || !text(row.authorityNodeId) || !integer(row.epoch) || !time(row.expiresAt) || !time(row.adoptedAt) || !time(revokedAt)) return unknown;
  for (const name of ["fencesForwarded", "materialPublished"]) if (Object.hasOwn(row, name) && typeof row[name] !== "boolean") return unknown;
  for (const name of ["authorityGenerationFloor", "legacyAuthorityGenerationFloor", "generation"]) if (Object.hasOwn(row, name) && !integer(row[name])) return unknown;
  for (const name of ["legacyAuthorityInstanceId", "authorityInstanceId", "viaNodeId"]) if (Object.hasOwn(row, name) && !text(row[name])) return unknown;
  for (const name of ["retiredAuthorityInstanceIds", "installedFiles"]) if (Object.hasOwn(row, name) && (!Array.isArray(row[name]) || !(row[name] as unknown[]).every(text))) return unknown;
  if (Object.hasOwn(row, "endedAt") && !time(row.endedAt)) return unknown;
  if (Object.hasOwn(row, "enrolment")) {
    const enrolment = row.enrolment;
    if (enrolment === null || typeof enrolment !== "object" || Array.isArray(enrolment)) return unknown;
    const record = enrolment as Record<string, unknown>;
    if (!text(record.id) || !time(record.at) || record.at === null || !integer(record.liveRuntimeCoveragePending)) return unknown;
  }
  const { endedAt: _endedAt, ...origin } = row;
  return { leasedFrom: { ...origin, revokedAt } as unknown as AccountLeaseOrigin };
}
