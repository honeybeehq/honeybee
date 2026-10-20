import assert from "node:assert/strict";
import { relativeCompletionHeadroom, DEFAULT_ACCOUNT_ADMISSION_POLICY, type AccountAdmissionCandidate } from "../../v2/core/src/accountAllocation.ts";
const now = 1_800_000_000_000;
const policy = { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now };
const candidate = (id: string, used: number, capacity = 1): AccountAdmissionCandidate => ({ accountId: id, capacityUnits: capacity, eligibility: { state: "eligible" }, quota: { fetchedAt: now, windows: [ { kind: "fiveHour", usedPercent: used, resetsAt: now + 3 * 3600000, velocityPerHour: 0, admissionCostPercent: 4 }, { kind: "weekly", usedPercent: 5, resetsAt: now + 48 * 3600000, velocityPerHour: 0, admissionCostPercent: 1 } ] }, activity: { coverage: "complete", active: 0, recent: 0, pending: 0, ongoingUnits: 0 }, reservations: 0 });
const record = (name: string, check: () => void) => { check(); console.log(JSON.stringify({ name, passed: true })); };
record("near_equal_30_logical_minutes", () => {
 for (let minute = 0; minute <= 30; minute++) {
  const a = candidate("a", 90); const b = candidate("b", 85);
  a.quota!.fetchedAt = b.quota!.fetchedAt = now + minute * 60000;
  assert.equal(relativeCompletionHeadroom(a, b, { ...policy, now: now + minute * 60000 }), false);
  assert.equal(relativeCompletionHeadroom(b, a, { ...policy, now: now + minute * 60000 }), false);
 }
});
record("reverse_double_margin", () => {
 assert.equal(relativeCompletionHeadroom(candidate("b", 90), candidate("a", 75), policy), true);
 assert.equal(relativeCompletionHeadroom(candidate("b", 90), candidate("a", 75), policy, 2), false);
});
record("binding_weekly_window", () => {
 const source = candidate("a", 5); source.quota!.windows[1]!.usedPercent = 90;
 const target = candidate("b", 5); target.quota!.windows[1]!.usedPercent = 85;
 assert.equal(relativeCompletionHeadroom(source, target, policy), false);
 target.quota!.windows[1]!.usedPercent = 5;
 assert.equal(relativeCompletionHeadroom(source, target, policy), true);
});
record("fable_and_missing_window", () => {
 const source = candidate("a", 5); source.quota!.windows.push({ ...source.quota!.windows[1]!, kind: "fableWeekly", usedPercent: 95 });
 const target = candidate("b", 5);
 assert.equal(relativeCompletionHeadroom(source, target, { ...policy, model: "fable" }), false);
 target.quota!.windows.push({ ...target.quota!.windows[1]!, kind: "fableWeekly", usedPercent: 5 });
 assert.equal(relativeCompletionHeadroom(source, target, { ...policy, model: "fable" }), true);
});
record("stale_alternative", () => {
 const target = candidate("b", 5); target.quota!.fetchedAt -= 120001;
 assert.equal(relativeCompletionHeadroom(candidate("a", 90), target, policy), false);
});
record("reservation_margin_before_reserve", () => {
 const source = candidate("a", 90); const target = candidate("b", 70);
 assert.equal(relativeCompletionHeadroom(source, target, policy), true);
 target.reservations = 3;
 assert.equal(relativeCompletionHeadroom(source, target, policy), false);
});
