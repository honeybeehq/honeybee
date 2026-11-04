import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRepair, parseIoClass, promoteScheduling, sampleScheduling } from "../src/processScheduling.ts";

function recordingExec(answers: Record<string, string[]>): { calls: string[]; exec: (file: string, args: string[]) => string } {
  const calls: string[] = [];
  return {
    calls,
    exec: (file, args) => {
      const key = `${file} ${args.join(" ")}`;
      calls.push(key);
      const queue = answers[key];
      if (!queue) throw Object.assign(new Error(`unexpected ${key}`), { stderr: "unexpected" });
      const next = queue.shift();
      if (next === undefined) throw new Error(`exhausted ${key}`);
      if (next.startsWith("!")) throw Object.assign(new Error(next.slice(1)), { stderr: next.slice(1) });
      return next;
    },
  };
}

test("this process samples as foreground on its own platform", () => {
  const sample = sampleScheduling({ probeIo: false });
  assert.equal(sample.nice, 0);
  assert.equal(sample.demoted, false);
});

test("parseIoClass reads ionice output", () => {
  assert.equal(parseIoClass("idle\n"), "idle");
  assert.equal(parseIoClass("best-effort: prio 4\n"), "best-effort");
  assert.equal(parseIoClass("none: prio 0\n"), "none");
  assert.equal(parseIoClass(""), null);
});

test("a darwin process in the throttled band is promoted with taskpolicy -B", () => {
  const pid = process.pid;
  const { calls, exec } = recordingExec({
    [`/bin/ps -o pri= -p ${pid}`]: ["  4\n", " 31\n"],
    [`/usr/sbin/taskpolicy -B -p ${pid}`]: [""],
  });
  const repair = promoteScheduling({ pid, platform: "darwin", exec });
  assert.deepEqual(calls, [`/bin/ps -o pri= -p ${pid}`, `/usr/sbin/taskpolicy -B -p ${pid}`, `/bin/ps -o pri= -p ${pid}`]);
  assert.equal(repair.before.demoted, true);
  assert.equal(repair.after.demoted, false);
  assert.deepEqual(repair.actions, ["taskpolicy -B"]);
  assert.equal(describeRepair(repair), "repaired pri 4, nice 0 -> pri 31, nice 0 via taskpolicy -B");
});

test("a darwin process at the timeshare priority is left alone", () => {
  const pid = process.pid;
  const { calls, exec } = recordingExec({ [`/bin/ps -o pri= -p ${pid}`]: [" 31\n"] });
  const repair = promoteScheduling({ pid, platform: "darwin", exec });
  assert.equal(calls.length, 1);
  assert.deepEqual(repair.actions, []);
  assert.equal(describeRepair(repair), "foreground (pri 31, nice 0)");
});

test("a failed taskpolicy is reported, not thrown", () => {
  const pid = process.pid;
  const { exec } = recordingExec({
    [`/bin/ps -o pri= -p ${pid}`]: ["  4\n", "  4\n"],
    [`/usr/sbin/taskpolicy -B -p ${pid}`]: ["!taskpolicy: setpriority: Operation not permitted"],
  });
  const repair = promoteScheduling({ pid, platform: "darwin", exec });
  assert.equal(repair.after.demoted, true);
  assert.deepEqual(repair.actions, []);
  assert.deepEqual(repair.errors, ["taskpolicy -B: taskpolicy: setpriority: Operation not permitted"]);
  assert.match(describeRepair(repair), /^still demoted pri 4, nice 0 -> pri 4, nice 0; taskpolicy -B: /);
});

test("a linux process in the idle io class is moved to best-effort", () => {
  const pid = process.pid;
  const { calls, exec } = recordingExec({
    [`ionice -p ${pid}`]: ["idle\n", "best-effort: prio 4\n"],
    [`ionice -c 2 -p ${pid}`]: [""],
  });
  const repair = promoteScheduling({ pid, platform: "linux", exec });
  assert.deepEqual(calls, [`ionice -p ${pid}`, `ionice -c 2 -p ${pid}`, `ionice -p ${pid}`]);
  assert.deepEqual(repair.actions, ["ionice best-effort"]);
  assert.equal(repair.after.demoted, false);
  assert.equal(describeRepair(repair), "repaired nice 0, io idle -> nice 0, io best-effort via ionice best-effort");
});
