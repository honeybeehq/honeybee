import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { listProcessRows, readProcessBirthFingerprint, inspectProcessBirth } from "../src/hsr/processIdentity.js";

test("POSIX census captures a real child birth and topology", { skip: process.platform === "win32" }, async t => {
  const probe = spawnSync("/bin/ps", ["-p", String(process.pid)], { encoding: "utf8" });
  if (probe.error) { t.skip(`system ps unavailable: ${probe.error.message}`); return; }
  assert.equal(probe.status, 0, probe.stderr);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
  try {
    assert.ok(child.pid);
    const birth = await readProcessBirthFingerprint(child.pid);
    assert.ok(birth);
    assert.equal(birth.pgid, child.pid);
    const row = (await listProcessRows()).find(r => r.pid === child.pid);
    assert.equal(row?.ppid, process.pid);
    assert.equal(row?.startedAt, birth.startedAt);
    assert.equal(await inspectProcessBirth(child.pid, birth), "match");
    assert.equal(await inspectProcessBirth(child.pid, { ...birth, startedAt: "Mon Jan  1 00:00:00 2001" }), "mismatch");
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("close", () => resolve()));
  }
});

test("denied process inspection remains unverifiable", async () => {
  const denied = async () => { throw Object.assign(new Error("spawn /bin/ps EPERM"), { code: "EPERM" }); };
  assert.equal(await inspectProcessBirth(12345, {
    pgid: 12345, startedAt: "Thu Sep 17 00:00:00 2026",
  }, denied), "unverifiable");
});
