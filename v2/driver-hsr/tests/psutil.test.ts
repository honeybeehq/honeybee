import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {spawn, spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {tmpdir} from "node:os";
import {createRequire} from "node:module";
import {once} from "node:events";
import {fileURLToPath} from "node:url";
import {decodeProcessInspection, inspectProcess, sameProcess} from "../../harness/src/processIdentity.ts";
import {legacyProcessCandidate, processDisposition, verifyProcessIdentity} from "../src/psutil.ts";

const live = {kind: "present", pid: 123, birth: "darwin:1000:1", bootId: "", uid: 1, ppid: 1, pgid: 123, state: "live", startedAtMs: 1000000, waitStatus: -1};
const identity = {pid: 123, birth: live.birth, bootId: ""};
test("Darwin native read includes unreaped zombies and preserves exact birth", {skip: process.platform !== "linux"}, () => {
  const root = mkdtempSync(join(tmpdir(), "hive-darwin-zombie-mock-"));
  try {
    const source = readFileSync(fileURLToPath(new URL("../../daemon/native/peercred.c", import.meta.url)), "utf8");
    const declaration = source.match(/typedef struct \{ pid_t pid,ppid,pgid;[^\n]+process_info;/)![0];
    const body = source.split("static int process_read(pid_t pid,process_info *out) {")[1]!.split("#elif defined(__linux__)")[0]!.replace("#ifdef __APPLE__", "");
    const unit = join(root, "darwin.c"), binary = join(root, "darwin");
    writeFileSync(unit, `#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include <stdint.h>
#define PROC_PIDTBSDINFO 3
#define SZOMB 5
struct proc_bsdinfo {uint32_t pbi_pid,pbi_uid,pbi_ppid,pbi_pgid,pbi_status; uint64_t pbi_start_tvsec,pbi_start_tvusec;};
static int mode=0;
static int proc_pidinfo(pid_t pid,int flavor,uint64_t arg,void *buf,int size) {
  assert(flavor==PROC_PIDTBSDINFO); assert(arg==1);
  if(mode==2) {errno=ESRCH; return 0;}
  if(mode==3) {errno=EPERM; return 0;}
  if(mode==4) return size-1;
  struct proc_bsdinfo *b=buf; memset(b,0,sizeof(*b));
  b->pbi_pid=pid; b->pbi_status=mode==0?2:SZOMB;
  b->pbi_start_tvsec=1000; b->pbi_start_tvusec=mode==5?2:1; return size;
}
${declaration}
static int process_read(pid_t pid,process_info *out) {${body}}
int main(void) {
  process_info a,b; assert(process_read(123,&a)==0); assert(!a.zombie);
  mode=1; assert(process_read(123,&b)==0); assert(b.zombie); assert(!strcmp(a.birth,b.birth));
  mode=5; assert(process_read(123,&b)==0); assert(strcmp(a.birth,b.birth));
  mode=2; assert(process_read(123,&b)==1);
  mode=3; assert(process_read(123,&b)==3);
  mode=4; assert(process_read(123,&b)==2); return 0;
}
`);
    const built = spawnSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", unit, "-o", binary], {encoding: "utf8", timeout: 15000});
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(binary, [], {encoding: "utf8", timeout: 5000});
    assert.equal(ran.status, 0, ran.stderr);
  } finally {rmSync(root, {recursive: true, force: true});}
});
test("native process union validates live, zombie, gone and unavailable without guessing death", () => {
  const present = decodeProcessInspection(live, 123);
  assert.equal(present.kind, "present");
  assert.equal(processDisposition(identity, present), "live");
  assert.equal(processDisposition(identity, decodeProcessInspection({...live, state: "zombie", waitStatus: 7}, 123)), "exited");
  assert.equal(processDisposition(identity, decodeProcessInspection({kind: "gone"}, 123)), "exited");
  for (const v of [null, {kind: "unavailable", reason: "native_observation_failed"}, {...live, pid: 124}, {...live, birth: "bad"}, {...live, startedAtMs: NaN}, {...live, startedAtMs: 0.999}, {...live, startedAtMs: Number.MAX_SAFE_INTEGER + 1}]) {
    assert.equal(processDisposition(identity, decodeProcessInspection(v, 123)), "unavailable");
  }
  assert.equal(processDisposition(null, {kind: "gone"}), "unavailable");
  assert.equal(processDisposition({...identity, birth: "darwin:999:1"}, present), "unavailable");
});
test("native birth milliseconds fit STRICT storage without weakening exact process identity", () => {
  const birth = "darwin:1000:123999";
  const observed = decodeProcessInspection({...live, birth, startedAtMs: 1000123.999}, 123);
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") return;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE observations (pid_started_at INTEGER) STRICT");
    db.prepare("INSERT INTO observations VALUES (?)").run(observed.startedAtMs);
    assert.equal(db.prepare("SELECT pid_started_at FROM observations").get()!.pid_started_at, 1000123);
    assert.equal(observed.birth, birth);
    assert.equal(sameProcess({pid: 123, birth, bootId: ""}, observed), true);
    assert.equal(sameProcess({pid: 123, birth: "darwin:1000:123998", bootId: ""}, observed), false);
    assert.ok(legacyProcessCandidate(123, 1000123, observed));
  } finally {db.close();}
});
test("legacy timestamp is discovery only and bounded to five seconds", () => {
  const present = decodeProcessInspection(live, 123);
  assert.ok(legacyProcessCandidate(123, 1000000, present));
  assert.equal(legacyProcessCandidate(123, 1005001, present), null);
  assert.equal(legacyProcessCandidate(124, 1000000, present), null);
  assert.equal(legacyProcessCandidate(123, 1000000, {kind: "gone"}), null);
});
test("real native self observation is exact and has no ps fallback", () => {
  const value = inspectProcess(process.pid);
  assert.equal(value.kind, "present");
  if (value.kind !== "present") return;
  assert.equal(value.state, "live");
  assert.equal(value.uid, process.getuid!());
  const own = {pid: process.pid, birth: value.birth, bootId: value.bootId};
  assert.equal(verifyProcessIdentity(process.pid, own), true);
  assert.equal(sameProcess({...own, birth: "darwin:1:0"}, value), false);
});
test("real native child transitions live to zombie to gone without a process census", {timeout: 15000}, async () => {
  const child = spawn("/usr/bin/python3", [fileURLToPath(new URL("./fixtures/zombie-parent.py", import.meta.url))], {stdio: ["pipe", "pipe", "pipe"]});
  const exited = once(child, "exit");
  try {
    const [chunk] = await once(child.stdout, "data");
    const pid = Number(String(chunk).trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const live = inspectProcess(pid); assert.equal(live.kind, "present");
    if (live.kind !== "present") throw new Error("Child inspection unavailable");
    assert.equal(live.state, "live");
    child.stdin.write("exit\n");
    let zombie = inspectProcess(pid);
    const deadline = Date.now() + 3000;
    while (zombie.kind === "present" && zombie.state === "live" && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); zombie = inspectProcess(pid); }
    assert.equal(zombie.kind, "present");
    if (zombie.kind !== "present") throw new Error("Zombie inspection unavailable");
    assert.equal(zombie.state, "zombie"); assert.equal(zombie.birth, live.birth);
    const retained = {pid, birth: live.birth, bootId: live.bootId};
    assert.equal(processDisposition(retained, zombie), "exited");
    assert.equal(verifyProcessIdentity(pid, retained), false, "zombie identity never grants signal authority");
    child.stdin.write("reap\n");
    await exited;
    assert.deepEqual(inspectProcess(pid), {kind: "gone"});
  } finally { child.stdin.end("reap\n"); await exited; }
});

test("native EPERM arm is unavailable and cannot become death or signal permission", {skip: process.platform !== "linux"}, () => {
  const root = mkdtempSync(join(tmpdir(), "hive-process-denied-"));
  try {
    const source = readFileSync(fileURLToPath(new URL("../../daemon/native/peercred.c", import.meta.url)), "utf8");
    const unit = join(root, "denied.c"), binary = join(root, "denied.node");
    writeFileSync(unit, '#define _GNU_SOURCE\n#include <stdio.h>\n#include <errno.h>\nstatic FILE *denied_fopen(const char *p,const char *m) {(void)p;(void)m;errno=EPERM;return NULL;}\n#define fopen denied_fopen\n' + source);
    const include = join(dirname(dirname(realpathSync(process.execPath))), "include/node");
    const build = spawnSync("cc", ["-DNAPI_VERSION=8", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", `-I${include}`, unit, "-o", binary], {encoding: "utf8", timeout: 15000});
    assert.equal(build.status, 0, build.stderr);
    const bridge = createRequire(import.meta.url)(binary) as {inspectProcess(pid: number): unknown};
    const value = bridge.inspectProcess(process.pid);
    assert.deepEqual(value, {kind: "unavailable", reason: "permission_denied"});
    assert.equal(processDisposition(identity, decodeProcessInspection(value, process.pid)), "unavailable");
  } finally {rmSync(root, {recursive: true, force: true});}
});

test("pidAlive treats an other-user permission denial as a reused pid but keeps unobservable pids alive", async () => {
  const { pidAlive } = await import("../src/psutil.ts");
  const bootId = "11111111-1111-1111-1111-111111111111";
  const cases = [
    [{ kind: "unavailable", reason: "permission_denied" }, false],
    [{ kind: "gone" }, false],
    [{ kind: "present", pid: 7, ppid: 1, uid: 0, pgid: 7, state: "zombie", birth: "linux:7", bootId, startedAtMs: 1, waitStatus: 0 }, false],
    [{ kind: "present", pid: 7, ppid: 1, uid: 0, pgid: 7, state: "live", birth: "linux:7", bootId, startedAtMs: 1, waitStatus: null }, true],
    [{ kind: "unavailable", reason: "native_observation_failed" }, true],
    [{ kind: "unavailable", reason: "artifact_unavailable" }, true],
  ] as const;
  for (const [value, alive] of cases) assert.equal(pidAlive(7, () => value), alive, JSON.stringify(value));
});
