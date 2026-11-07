import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildHealthMonitor, countZombieChildren, readZombieChildren } from "../src/childHealth.ts";

test("child census counts only the daemon's zombie children", () => {
  assert.equal(countZombieChildren(" 123 Z\n123 Z+\n123 S\n124 Z\n", 123), 2);
});

test("child census is single-flight, warns above threshold and clears on recovery", async () => {
  const logs: string[] = [];
  let finish!: (value: number) => void;
  let calls = 0;
  const monitor = new ChildHealthMonitor(line => logs.push(line), () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = monitor.check();
  assert.equal(monitor.check(), pending);
  assert.equal(calls, 1);
  finish(4);
  await pending;
  assert.equal(monitor.status.state, "warning");
  assert.match(logs[0]!, /warning count=4 threshold=3/);
  const recovery = monitor.check(); finish(0); await recovery;
  assert.equal(monitor.status.state, "ok");
  const boundary = monitor.check(); finish(3); await boundary;
  assert.equal(monitor.status.state, "ok");
  assert.equal(logs.length, 1);
});

test("failed census reports unavailable rather than a healthy zero", async () => {
  const logs: string[] = [];
  const monitor = new ChildHealthMonitor(line => logs.push(line), async () => { throw new Error("EAGAIN"); });
  await monitor.check();
  assert.equal(monitor.status.state, "unavailable");
  assert.deepEqual(logs, ["daemon.children.census_unavailable"]);
});

test("real process listing observes this test process", { skip: process.platform === "win32" }, async () => {
  assert.equal(await readZombieChildren(process.pid), 0);
});
