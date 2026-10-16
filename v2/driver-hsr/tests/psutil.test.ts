import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";

test("psutil: a zombie census whose ps cannot exec never throws and pidAlive keeps the kill(pid, 0) answer", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const realExecFile = childProcess.execFile;
  let calls = 0;
  (childProcess as { execFile: unknown }).execFile = () => {
    calls += 1;
    throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
  };
  syncBuiltinESMExports();
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.message);
  process.on("warning", onWarning);
  t.after(() => {
    (childProcess as { execFile: unknown }).execFile = realExecFile;
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    process.off("warning", onWarning);
  });

  const { pidAlive } = await import(`../src/psutil.ts?eperm=${Date.now()}`);
  assert.equal(pidAlive(process.pid), true, "a live pid stays alive when the census cannot run");
  assert.equal(pidAlive(process.pid), true, "a second probe does not throw");
  assert.equal(pidAlive(2 ** 22 - 1), false, "a dead pid is still dead");
  assert.equal(calls, 1, "a failed census is not retried within its interval");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warnings.filter((message) => message.includes("zombie census unavailable")).length, 1, "one warning per process lifetime");
});

test("psutil: an async ps spawn failure is not respawned in a loop", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const realExecFile = childProcess.execFile;
  let calls = 0;
  (childProcess as { execFile: unknown }).execFile = (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    calls += 1;
    setImmediate(() => callback(Object.assign(new Error("spawn /bin/ps ENOENT"), { code: "ENOENT" }), ""));
  };
  syncBuiltinESMExports();
  t.after(() => {
    (childProcess as { execFile: unknown }).execFile = realExecFile;
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  });

  const { pidAlive } = await import(`../src/psutil.ts?enoent=${Date.now()}`);
  const deadline = Date.now() + 200;
  while (Date.now() < deadline) {
    assert.equal(pidAlive(process.pid), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(calls, 1, "execFile is called at most once in 200 ms after an async spawn failure");
});
