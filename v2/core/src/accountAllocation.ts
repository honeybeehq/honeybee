/**
 * Admission policy for NEW automatic account work. Pure: callers supply a
 * clock, fresh provider quota, authoritative activity, and durable held-start
 * counts. Existing sessions and explicit account choices never enter here.
 */

export type AccountAdmissionWindowKind = "fiveHour" | "weekly" | "fableWeekly";

export interface AccountAdmissionWindow {
  kind: AccountAdmissionWindowKind;
  usedPercent: number;
  resetsAt: number;
  /** Observed ongoing burn in provider percentage points per hour. */
  velocityPerHour: number;
  /** Conservative short-horizon cost of one new start, in percentage points per hour. */
  admissionCostPercent: number;
}

export interface AccountAdmissionQuota {
  fetchedAt: number;
  windows: AccountAdmissionWindow[];
}

export type AccountAdmissionEligibility =
  | { state: "eligible" }
  | { state: "ineligible"; reason: "provider" | "model" | "auth" | "grants" | "paused" | "exhausted" }
  | { state: "unknown"; reason: "model" | "auth" | "grants" };

export interface AccountAdmissionActivity {
  /** Complete includes every other execution node in the allocation scope. */
  coverage: "complete" | "unknown";
  active: number;
  recent: number;
  pending: number;
  /** Ongoing service already consumed, in the same fair-share units as starts. */
  ongoingUnits: number;
}

export interface AccountAdmissionCandidate {
  accountId: string;
  /** Comparable allowance units for this plan; e.g. a 3x plan uses 3. */
  capacityUnits: number;
  eligibility: AccountAdmissionEligibility;
  quota: AccountAdmissionQuota | null;
  activity: AccountAdmissionActivity;
  /** Unreconciled durable start holds, including remote holds. */
  reservations: number;
}

export interface AccountAdmissionPolicy {
  now: number;
  model?: string;
  requestUnits?: number;
  quotaFreshMs: number;
  completionReservePercent: number;
  projectionHorizonHours: number;
  nearResetFloorHours: number;
}

export const DEFAULT_ACCOUNT_ADMISSION_POLICY: Readonly<Omit<AccountAdmissionPolicy, "now">> = {
  requestUnits: 1,
  quotaFreshMs: 2 * 60 * 1000,
  completionReservePercent: 90,
  projectionHorizonHours: 1,
  nearResetFloorHours: 6,
};

export type AccountAdmissionWaitReason =
  | "no_eligible_account"
  | "activity_unknown"
  | "quota_uncertain"
  | "completion_reserve";

export interface AccountAdmissionCandidateReceipt {
  accountId: string;
  status: "eligible" | "ineligible" | "uncertain" | "protected";
  reason?: string;
  rate?: number;
  fairFinish?: number;
  maxProjectedPercent?: number;
}

export type AccountAdmissionDecision =
  | {
      kind: "selected";
      accountId: string;
      reason: "weighted_fair";
      rate: number;
      fairFinish: number;
      maxProjectedPercent: number;
      candidates: AccountAdmissionCandidateReceipt[];
    }
  | {
      kind: "wait";
      reason: AccountAdmissionWaitReason;
      retryAt: number | null;
      candidates: AccountAdmissionCandidateReceipt[];
    };

function fableModel(model: string | undefined): boolean {
  return typeof model === "string" && /(?:^|[-_/])fable(?:[-_/]|$)/i.test(model);
}

function applicableWindows(candidate: AccountAdmissionCandidate, model: string | undefined): AccountAdmissionWindow[] {
  const useFable = fableModel(model);
  return candidate.quota?.windows.filter((window) => window.kind !== "fableWeekly" || useFable) ?? [];
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function usableWindow(window: AccountAdmissionWindow, now: number): boolean {
  return finiteNonNegative(window.usedPercent)
    && finiteNonNegative(window.velocityPerHour)
    && finiteNonNegative(window.admissionCostPercent)
    && Number.isFinite(window.resetsAt)
    && window.resetsAt > now;
}

function activityPresent(candidate: AccountAdmissionCandidate): boolean {
  const a = candidate.activity;
  return a.active > 0 || a.recent > 0 || a.pending > 0 || candidate.reservations > 0;
}

function waitReason(reasons: Set<AccountAdmissionWaitReason>): AccountAdmissionWaitReason {
  if (reasons.has("completion_reserve")) return "completion_reserve";
  if (reasons.has("activity_unknown")) return "activity_unknown";
  if (reasons.has("quota_uncertain")) return "quota_uncertain";
  return "no_eligible_account";
}

/**
 * Weighted-fair admission. Each accepted start advances the selected
 * account's durable reservation count; minimizing virtual finish therefore
 * converges to starts proportional to remaining allowance rates without
 * greedily draining the currently largest account.
 */
export function selectAccountAdmission(
  candidates: readonly AccountAdmissionCandidate[],
  policy: AccountAdmissionPolicy,
): AccountAdmissionDecision {
  const requestUnits = policy.requestUnits ?? 1;
  const receipts: AccountAdmissionCandidateReceipt[] = [];
  const selectable: Array<AccountAdmissionCandidateReceipt & { accountId: string; retryAt: number }> = [];
  const reasons = new Set<AccountAdmissionWaitReason>();
  let retryAt: number | null = null;

  for (const candidate of candidates) {
    if (candidate.eligibility.state === "ineligible") {
      receipts.push({ accountId: candidate.accountId, status: "ineligible", reason: candidate.eligibility.reason });
      reasons.add("no_eligible_account");
      continue;
    }
    if (candidate.eligibility.state === "unknown") {
      receipts.push({ accountId: candidate.accountId, status: "uncertain", reason: candidate.eligibility.reason });
      reasons.add("no_eligible_account");
      continue;
    }
    if (candidate.activity.coverage !== "complete") {
      receipts.push({ accountId: candidate.accountId, status: "uncertain", reason: "activity_unknown" });
      reasons.add("activity_unknown");
      continue;
    }
    const quota = candidate.quota;
    const windows = applicableWindows(candidate, policy.model);
    if (
      !quota
      || !Number.isFinite(quota.fetchedAt)
      || quota.fetchedAt > policy.now + 60_000
      || policy.now - quota.fetchedAt > policy.quotaFreshMs
      || windows.length === 0
      || windows.some((window) => !usableWindow(window, policy.now))
      || !(candidate.capacityUnits > 0 && Number.isFinite(candidate.capacityUnits))
    ) {
      receipts.push({ accountId: candidate.accountId, status: "uncertain", reason: "quota_uncertain" });
      reasons.add("quota_uncertain");
      continue;
    }

    const projected = windows.map((window) => {
      const remainingHours = (window.resetsAt - policy.now) / 3_600_000;
      const horizon = Math.min(policy.projectionHorizonHours, remainingHours);
      return window.usedPercent
        + window.velocityPerHour * horizon
        + window.admissionCostPercent * horizon * (candidate.reservations + candidate.activity.pending + requestUnits);
    });
    const maxProjectedPercent = Math.max(...projected);
    const protectedNow = activityPresent(candidate)
      && windows.some((window) => window.usedPercent >= policy.completionReservePercent);
    const protectedProjected = projected.some((percent) => percent >= policy.completionReservePercent);
    if (protectedNow || protectedProjected) {
      receipts.push({ accountId: candidate.accountId, status: "protected", reason: "completion_reserve", maxProjectedPercent });
      reasons.add("completion_reserve");
      const nextReset = Math.min(...windows.map((window) => window.resetsAt));
      retryAt = retryAt === null ? nextReset : Math.min(retryAt, nextReset);
      continue;
    }

    const weekly = windows.filter((window) => window.kind === "weekly" || window.kind === "fableWeekly");
    const rateWindows = weekly.length > 0 ? weekly : windows;
    const rate = Math.min(...rateWindows.map((window) => {
      const usablePercent = Math.max(0, policy.completionReservePercent - window.usedPercent);
      const hours = Math.max(policy.nearResetFloorHours, (window.resetsAt - policy.now) / 3_600_000);
      return candidate.capacityUnits * usablePercent / 100 / hours;
    }));
    if (!(rate > 0 && Number.isFinite(rate))) {
      receipts.push({ accountId: candidate.accountId, status: "protected", reason: "completion_reserve", maxProjectedPercent });
      reasons.add("completion_reserve");
      continue;
    }
    const fairFinish = (Math.max(0, candidate.activity.ongoingUnits) + Math.max(0, candidate.reservations) + requestUnits) / rate;
    const receipt: AccountAdmissionCandidateReceipt & { accountId: string; retryAt: number } = {
      accountId: candidate.accountId,
      status: "eligible",
      rate,
      fairFinish,
      maxProjectedPercent,
      retryAt: Math.min(...windows.map((window) => window.resetsAt)),
    };
    receipts.push(receipt);
    selectable.push(receipt);
  }

  selectable.sort((a, b) => a.fairFinish! - b.fairFinish! || a.accountId.localeCompare(b.accountId));
  const selected = selectable[0];
  if (!selected) {
    return { kind: "wait", reason: waitReason(reasons), retryAt, candidates: receipts.slice(0, 16) };
  }
  return {
    kind: "selected",
    accountId: selected.accountId,
    reason: "weighted_fair",
    rate: selected.rate!,
    fairFinish: selected.fairFinish!,
    maxProjectedPercent: selected.maxProjectedPercent!,
    candidates: receipts.slice(0, 16),
  };
}
