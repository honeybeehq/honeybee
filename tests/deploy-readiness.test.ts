import assert from "node:assert/strict";
import { test } from "node:test";
import { DeployReadinessError, waitForDeployReadiness, type DeployReadinessObservation } from "../src/deployReadiness.js";

const identity = { pid: 123, birth: "darwin:1:1", bootId: "" };

function fixture(observe: (ms: number) => DeployReadinessObservation, limits = { stallMs: 300, hardCapMs: 15_000 }) {
  let elapsed = 0;
  return {
    elapsed: () => elapsed,
    run: () => waitForDeployReadiness({ observe: async () => observe(elapsed), now: () => elapsed, sleep: async ms => { elapsed += ms; }, pollMs: 100, ...limits }),
  };
}

test("deploy waits beyond ten seconds while the same process makes startup progress", async () => {
  const f = fixture(ms => ({ ready: ms >= 12_000, process: identity, progress: String(ms) }));
  await f.run();
  assert.equal(f.elapsed(), 12_000);
});

test("deploy bounds a live startup that stops making progress", async () => {
  const f = fixture(() => ({ ready: false, process: identity, progress: "unchanged" }));
  await assert.rejects(f.run(), error => error instanceof DeployReadinessError && error.code === "READINESS_STALLED");
  assert.equal(f.elapsed(), 300);
});

test("deploy detects an exited startup process before the stall deadline", async () => {
  const f = fixture(ms => ({ ready: false, process: ms === 0 ? identity : undefined, processGone: ms > 0, progress: "unchanged" }));
  await assert.rejects(f.run(), error => error instanceof DeployReadinessError && error.code === "READINESS_EXITED");
  assert.equal(f.elapsed(), 100);
});

test("deploy never follows a reused PID or replacement service process", async () => {
  const f = fixture(ms => ({ ready: false, process: { ...identity, birth: ms ? "darwin:2:2" : identity.birth }, progress: String(ms) }));
  await assert.rejects(f.run(), error => error instanceof DeployReadinessError && error.code === "READINESS_IDENTITY_CHANGED");
});

test("deploy has a total bound even when startup continuously reports progress", async () => {
  const f = fixture(ms => ({ ready: false, process: identity, progress: String(ms) }), { stallMs: 300, hardCapMs: 1_000 });
  await assert.rejects(f.run(), error => error instanceof DeployReadinessError && error.code === "READINESS_LIMIT");
  assert.equal(f.elapsed(), 1_000);
});

test("deploy refuses a Node repair hold immediately", async () => {
  const f = fixture(() => ({ ready: false, repair: true, progress: "repair" }));
  await assert.rejects(f.run(), error => error instanceof DeployReadinessError && error.code === "READINESS_REPAIR");
  assert.equal(f.elapsed(), 0);
});
