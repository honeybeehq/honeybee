import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ACCOUNT_ADMISSION_POLICY,
  selectAccountAdmission,
  type AccountAdmissionCandidate,
} from "../src/index.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-21T09:00:00Z");

function candidate(
  accountId: string,
  overrides: Partial<AccountAdmissionCandidate> = {},
): AccountAdmissionCandidate {
  return {
    accountId,
    capacityUnits: 1,
    eligibility: { state: "eligible" },
    quota: {
      fetchedAt: NOW,
      windows: [
        { kind: "fiveHour", usedPercent: 20, resetsAt: NOW + 3 * HOUR, velocityPerHour: 0, admissionCostPercent: 2 },
        { kind: "weekly", usedPercent: 20, resetsAt: NOW + 4 * 24 * HOUR, velocityPerHour: 0, admissionCostPercent: 1 },
      ],
    },
    activity: { coverage: "complete", active: 0, recent: 0, pending: 0, ongoingUnits: 0 },
    reservations: 0,
    ...overrides,
  };
}

test("admission: weighted fair starts follow remaining-capacity rates instead of a greedy best score", () => {
  const candidates = [
    candidate("large", { capacityUnits: 3 }),
    candidate("small", { capacityUnits: 1 }),
  ];
  const counts = new Map<string, number>();
  for (let i = 0; i < 40; i += 1) {
    const decision = selectAccountAdmission(candidates, { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW });
    assert.equal(decision.kind, "selected");
    if (decision.kind !== "selected") return;
    counts.set(decision.accountId, (counts.get(decision.accountId) ?? 0) + 1);
    const selected = candidates.find((item) => item.accountId === decision.accountId)!;
    selected.reservations += 1;
  }
  assert.deepEqual(Object.fromEntries(counts), { large: 30, small: 10 });
});

test("admission: the 90 percent completion reserve is hard for active, recent, pending, and projected work", () => {
  for (const activity of [
    { coverage: "complete" as const, active: 1, recent: 0, pending: 0, ongoingUnits: 1 },
    { coverage: "complete" as const, active: 0, recent: 1, pending: 0, ongoingUnits: 0.5 },
    { coverage: "complete" as const, active: 0, recent: 0, pending: 1, ongoingUnits: 1 },
  ]) {
    const hot = candidate("hot", {
      quota: { fetchedAt: NOW, windows: [{ kind: "weekly", usedPercent: 90, resetsAt: NOW + 2 * HOUR, velocityPerHour: 0, admissionCostPercent: 1 }] },
      activity,
    });
    const decision = selectAccountAdmission([hot], { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW });
    assert.equal(decision.kind, "wait");
    if (decision.kind === "wait") assert.equal(decision.reason, "completion_reserve");
  }

  const crossing = candidate("crossing", {
    quota: { fetchedAt: NOW, windows: [{ kind: "weekly", usedPercent: 89, resetsAt: NOW + 2 * HOUR, velocityPerHour: 0, admissionCostPercent: 2 }] },
  });
  const projected = selectAccountAdmission([crossing], { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW });
  assert.equal(projected.kind, "wait");
  if (projected.kind === "wait") assert.equal(projected.reason, "completion_reserve");

  const acceptedPending = candidate("pending-crossing", {
    quota: { fetchedAt: NOW, windows: [{ kind: "weekly", usedPercent: 88, resetsAt: NOW + 2 * HOUR, velocityPerHour: 0, admissionCostPercent: 1 }] },
    activity: { coverage: "complete", active: 0, recent: 0, pending: 1, ongoingUnits: 1 },
  });
  assert.equal(
    selectAccountAdmission([acceptedPending], { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW }).kind,
    "wait",
    "accepted pending work and this reservation are both projected before crossing 90",
  );
});

test("admission: stale, absent, past-reset, and remotely-unknown facts are uncertainty, never empty capacity", () => {
  const stale = candidate("stale", { quota: { ...candidate("x").quota!, fetchedAt: NOW - 10 * 60_000 } });
  const absent = candidate("absent", { quota: null });
  const pastReset = candidate("past", {
    quota: { fetchedAt: NOW, windows: [{ kind: "weekly", usedPercent: 99, resetsAt: NOW - 1, velocityPerHour: 0, admissionCostPercent: 1 }] },
  });
  const remoteUnknown = candidate("unknown", {
    activity: { coverage: "unknown", active: 0, recent: 0, pending: 0, ongoingUnits: 0 },
  });
  for (const [item, reason] of [
    [stale, "quota_uncertain"],
    [absent, "quota_uncertain"],
    [pastReset, "quota_uncertain"],
    [remoteUnknown, "activity_unknown"],
  ] as const) {
    const decision = selectAccountAdmission([item], { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW, quotaFreshMs: 2 * 60_000 });
    assert.equal(decision.kind, "wait");
    if (decision.kind === "wait") assert.equal(decision.reason, reason);
  }

  const verifiedReset = candidate("restored", {
    quota: { fetchedAt: NOW, windows: [{ kind: "weekly", usedPercent: 3, resetsAt: NOW + 7 * 24 * HOUR, velocityPerHour: 0, admissionCostPercent: 1 }] },
  });
  assert.equal(selectAccountAdmission([verifiedReset], { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW }).kind, "selected");
});

test("admission: ongoing long-session consumption participates in fairness and old idle work does not", () => {
  const long = candidate("long", {
    activity: { coverage: "complete", active: 1, recent: 0, pending: 0, ongoingUnits: 12 },
  });
  const oldIdle = candidate("idle", {
    activity: { coverage: "complete", active: 0, recent: 0, pending: 0, ongoingUnits: 0 },
  });
  const decision = selectAccountAdmission([long, oldIdle], { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW });
  assert.equal(decision.kind, "selected");
  if (decision.kind === "selected") assert.equal(decision.accountId, "idle");
});

test("admission: model-scoped windows are applicable only to that model", () => {
  const constrained = candidate("constrained", {
    quota: {
      fetchedAt: NOW,
      windows: [
        { kind: "weekly", usedPercent: 10, resetsAt: NOW + 4 * 24 * HOUR, velocityPerHour: 0, admissionCostPercent: 1 },
        { kind: "fableWeekly", usedPercent: 91, resetsAt: NOW + 4 * 24 * HOUR, velocityPerHour: 0, admissionCostPercent: 1 },
      ],
    },
    activity: { coverage: "complete", active: 1, recent: 0, pending: 0, ongoingUnits: 1 },
  });
  assert.equal(selectAccountAdmission([constrained], { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW }).kind, "selected");
  const fable = selectAccountAdmission([constrained], { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW, model: "claude-fable-5" });
  assert.equal(fable.kind, "wait");
  if (fable.kind === "wait") assert.equal(fable.reason, "completion_reserve");
});

test("admission simulator: mixed plans avoid reset herds and Fable-only saturation deterministically", () => {
  const candidates = [
    candidate("max", { capacityUnits: 3 }),
    candidate("pro"),
    candidate("fable-hot", {
      quota: {
        fetchedAt: NOW,
        windows: [
          { kind: "weekly", usedPercent: 15, resetsAt: NOW + 5 * 24 * HOUR, velocityPerHour: 0, admissionCostPercent: 1 },
          { kind: "fableWeekly", usedPercent: 90, resetsAt: NOW + 5 * 24 * HOUR, velocityPerHour: 0, admissionCostPercent: 1 },
        ],
      },
      activity: { coverage: "complete", active: 1, recent: 0, pending: 0, ongoingUnits: 1 },
    }),
  ];
  const starts = new Map<string, number>();
  for (let i = 0; i < 20; i += 1) {
    const model = i % 2 === 0 ? "claude-fable-5" : "claude-sonnet-5";
    const decision = selectAccountAdmission(candidates, { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW, model });
    assert.equal(decision.kind, "selected");
    if (decision.kind !== "selected") continue;
    if (model.includes("fable")) assert.notEqual(decision.accountId, "fable-hot", "Fable work never herds onto its protected scoped window");
    starts.set(decision.accountId, (starts.get(decision.accountId) ?? 0) + 1);
    candidates.find((item) => item.accountId === decision.accountId)!.reservations += 1;
  }
  assert.ok((starts.get("pro") ?? 0) > 0, "the lower-weight plan never starves");
  assert.ok((starts.get("max") ?? 0) > (starts.get("pro") ?? 0), "mixed-plan starts follow capacity rate");

  const resetOnly = candidate("reset-only", {
    quota: { fetchedAt: NOW, windows: [{ kind: "weekly", usedPercent: 99, resetsAt: NOW - 1, velocityPerHour: 0, admissionCostPercent: 1 }] },
  });
  assert.equal(
    selectAccountAdmission([resetOnly], { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW }).kind,
    "wait",
    "an elapsed reset timestamp alone never fabricates restored headroom",
  );
  resetOnly.quota = {
    fetchedAt: NOW + 1,
    windows: [{ kind: "weekly", usedPercent: 2, resetsAt: NOW + 7 * 24 * HOUR, velocityPerHour: 0, admissionCostPercent: 1 }],
  };
  assert.equal(
    selectAccountAdmission([resetOnly], { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: NOW + 1 }).kind,
    "selected",
    "a fresh verified post-reset snapshot reopens admission",
  );
});
