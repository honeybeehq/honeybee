import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const directory = resolve(process.argv[2]);
const bridge = createRequire(import.meta.url)(join(directory, "peercred.node"));
if (process.argv[3] === "--expect-permission-denied") {
  const result = bridge.inspectProcess(Number(process.argv[4]));
  assert.deepEqual(result, {kind: "unavailable", reason: "permission_denied"});
  console.log(JSON.stringify({unavailable: "permission_denied"}));
} else {
  const root = mkdtempSync(join(tmpdir(), "hive-process-proof-"));
  const parent = spawn("/usr/bin/python3", [fileURLToPath(new URL("../v2/driver-hsr/tests/fixtures/zombie-parent.py", import.meta.url))], {stdio: ["pipe", "pipe", "pipe"]});
  const exited = once(parent, "exit");
  try {
    const [chunk] = await once(parent.stdout, "data"), pid = Number(String(chunk).trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const live = bridge.inspectProcess(pid); assert.equal(live.kind, "present"); assert.equal(live.state, "live");
    parent.stdin.write("exit\n");
    const deadline = Date.now() + 3000; let zombie;
    do { zombie = bridge.inspectProcess(pid); if (zombie.kind === "present" && zombie.state === "zombie") break; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
    assert.equal(zombie.kind, "present"); assert.equal(zombie.state, "zombie"); assert.equal(zombie.birth, live.birth); assert.equal(zombie.bootId, live.bootId);
    parent.stdin.write("reap\n"); await exited;
    assert.deepEqual(bridge.inspectProcess(pid), {kind: "gone"});
    let permission = "darwin_control_not_run_on_linux";
    if (process.platform === "darwin") {
      const profile = join(root, "deny-process-info.sb");
      writeFileSync(profile, "(version 1)\n(allow default)\n(deny process-info*)\n", {mode: 0o600});
      const result = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, fileURLToPath(import.meta.url), directory, "--expect-permission-denied", String(process.pid)], {encoding: "utf8", timeout: 5000});
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {unavailable: "permission_denied"});
      permission = "permission_denied";
    }
    console.log(JSON.stringify({passed: true, live: "live", zombie: "zombie", gone: "gone", unavailable: permission}));
  } finally {parent.stdin.end("reap\n"); await exited; rmSync(root, {recursive: true, force: true});}
}
