import { test } from "node:test";
import assert from "node:assert/strict";
import { CellDriver } from "../src/driver.ts";
import type { HsrDriver } from "../../driver-hsr/src/driver.ts";

test("Cell delegates fresh delivery and confirmation planning options intact", () => {
  const calls: unknown[][] = [];
  const driver = Object.create(CellDriver.prototype) as CellDriver;
  const options = { freshTurn: true, singleAttempt: true };
  const inner = {
    deliver(...args: unknown[]) { calls.push(args); return { accepted: false, reason: "not_ready" as const }; },
    planDeliveryConfirmation(...args: unknown[]) { calls.push(args); return "not_ready" as const; },
  };
  (driver as unknown as { inner: Pick<HsrDriver, "deliver" | "planDeliveryConfirmation"> }).inner = inner;
  assert.deepEqual(driver.deliver("bee", 4, 7, "fresh", options), { accepted: false, reason: "not_ready" });
  assert.equal(driver.planDeliveryConfirmation("bee", 4, 7, "fresh", options), "not_ready");
  assert.deepEqual(calls, [["bee", 4, 7, "fresh", options], ["bee", 4, 7, "fresh", options]]);
  assert.equal(calls[0]![4], options);
  assert.equal(calls[1]![4], options);
});
