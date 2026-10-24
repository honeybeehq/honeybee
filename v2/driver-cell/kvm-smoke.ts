import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { loadNodeConfig } from "../daemon/src/config.ts";
import { runCellExec } from "./src/exec.ts";
import { git } from "./src/git.ts";
import { provisionCell } from "./src/provision.ts";

assert.equal(platform(), "linux", "run on a Linux host with accessible /dev/kvm");
const root = mkdtempSync(join(homedir(), ".hive-kvm-smoke-"));
console.log(`scratch fixture: ${root}`);
const origin = join(root, "origin");
mkdirSync(origin);
git(origin, ["init", "-b", "main"]);
git(origin, ["-c", "user.name=kvm-smoke", "-c", "user.email=kvm@hive.invalid", "commit", "--allow-empty", "-m", "scratch"]);
const sha = git(origin, ["rev-parse", "HEAD"]).trim();
const cell = provisionCell(join(root, "cells"), {
  beeId: "kvm-smoke",
  originRepo: origin,
  sha,
  wrapper: "kvm-smoke",
  repoName: "scratch",
  cellId: "kvm",
}, "scratch-kvm", { disableCow: true, useGitImages: false });

const probe = String.raw`
import errno, fcntl, json, os, stat, sys
devices = {}
for directory, dirs, files in os.walk("/dev", followlinks=False):
    dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(directory, d))]
    for name in files:
        path = os.path.join(directory, name)
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            continue
        if stat.S_ISCHR(info.st_mode) or stat.S_ISBLK(info.st_mode):
            devices[path] = [os.major(info.st_rdev), os.minor(info.st_rdev)]
result = {"devices": devices, "groups": os.getgroups()}
try:
    fd = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
except OSError as error:
    result["kvm_open_errno"] = error.errno
else:
    result["kvm_api"] = fcntl.ioctl(fd, 0xae00, 0)
    vm = fcntl.ioctl(fd, 0xae01, 0)
    os.close(vm)
    os.close(fd)
    result["vm_created"] = True
if len(sys.argv) > 1:
    try:
        fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT, 0o600)
    except OSError as error:
        assert error.errno == errno.EROFS, error
        result["outside_write"] = "EROFS"
    else:
        os.close(fd)
        raise AssertionError("sandbox allowed a write outside the Cell")
print(json.dumps(result, sort_keys=True))
`;
const hostRun = spawnSync("python3", ["-c", probe], { encoding: "utf8" });
assert.equal(hostRun.status, 0, hostRun.stderr);
const host = JSON.parse(hostRun.stdout);
assert.equal(host.kvm_api, 12);
console.log(`host: ${hostRun.stdout.trim()}`);

const configDir = join(root, "config");
mkdirSync(configDir);
assert.equal(loadNodeConfig(configDir).cellKvm, false);
const snapshots = [];
for (const enabled of [false, true, false]) {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ cells: { kvm: enabled } }));
  const config = loadNodeConfig(configDir);
  const outcome = await runCellExec(cell.paths, {
    argv: ["python3", "-c", probe, join(root, "outside-write")],
    sandbox: true,
    nodeKind: "satellite",
    kvm: config.cellKvm,
  });
  assert.equal(outcome.status, "ok", outcome.stderr);
  const snapshot = JSON.parse(outcome.stdout);
  assert.equal(snapshot.outside_write, "EROFS");
  if (enabled) {
    assert.equal(snapshot.kvm_api, 12);
    assert.equal(snapshot.vm_created, true);
  } else {
    assert.equal(snapshot.kvm_open_errno, 2);
  }
  console.log(`cells.kvm=${enabled}: ${outcome.stdout.trim()}`);
  snapshots.push(snapshot);
}
const [before, after, disabled] = snapshots;
assert.deepEqual(after.devices, { ...before.devices, "/dev/kvm": host.devices["/dev/kvm"] });
assert.deepEqual(after.groups, before.groups);
assert.deepEqual(disabled.devices, before.devices);
const hidden = Object.keys(host.devices).filter((path) => !(path in after.devices));
assert.ok(hidden.length > 0, "host must have other devices to prove isolation");
console.log(`other host devices still hidden (${hidden.length}): ${hidden.join(", ")}`);
writeFileSync(join(configDir, "config.json"), JSON.stringify({ cells: { kvm: "true" } }));
assert.throws(() => loadNodeConfig(configDir), /cells.kvm must be a boolean/);
console.log("PASS: opt-in adds only /dev/kvm; VM creation works; groups and write confinement are unchanged; disabling hides KVM again");
