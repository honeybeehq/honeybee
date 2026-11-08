import { exactProcessBirth, inspectProcess } from "../../harness/src/processIdentity.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forceStopTestDaemon, liveRunnerHostPids, makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import type { SpawnResult, ViewResult } from "../src/protocol.ts";
import { openCoreStore } from "../../core/src/index.ts";

const MARKER = "hb-teardown-writer";

for (const mode of ["recover", "torn", "timeout"] as const) test(`test teardown ${mode === "timeout" ? "fails and reaps its survivor when ownership recovery stays unresolved" : mode === "torn" ? "retries a torn survivor receipt before stopping recovery" : "waits for survivor ownership before stopping recovery"}`, { timeout: 60_000 }, async () => {
  const recover = mode !== "timeout";
  const rig = makeDaemonDir();
  let daemon: DaemonHandle | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    const store = openCoreStore(join(rig.dir, "core.sqlite3"), { ephemeral: true });
    const placeholder = store.createBee({ name: "unowned-placeholder", agent: "stub", substrate: "hsr", cwd: rig.dir });
    store.updateRuntimeState(placeholder.bee.id, placeholder.runtime.generation, "running", { pid: 303, pidStartedAt: 3003 });
    store.close();
    daemon = await startDaemon(rig.dir);
    let client = await daemon.client();
    const { beeId } = await client.request<SpawnResult>("spawn", { name: "held-adoption", agent: "stub", cwd: rig.dir });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).runtime?.state === "idle", "original runner ready", 30_000);
    client.close();
    await daemon.kill();
    const releasePath = join(rig.dir, "release-adoption");
    const loader = new URL("./fixtures/hold-runner-adoption.mjs", import.meta.url).pathname;
    daemon = await startDaemon(rig.dir, { ownershipTimeoutMs: recover ? 30_000 : 100, env: { NODE_OPTIONS: `--import=${loader}`, HIVE_TEST_ADOPTION_RELEASE: releasePath } });
    client = await daemon.client();
    const view = await client.request<ViewResult>("view", { beeId });
    assert.ok((await client.request<ViewResult>("view", { beeId: placeholder.bee.id })).identityDiagnostic,
      "a synthetic PID may remain unresolved without belonging to the fixture");
    client.close();
    assert.equal(view.runtime?.state, "idle", "persisted idle alone does not prove recovered ownership");
    assert.ok(view.identityDiagnostic);
    assert.equal(liveRunnerHostPids(rig.dir).length, 1);
    const nativeHost = inspectProcess(view.runtime!.pid!);
    if (nativeHost.kind !== "present") throw new Error("Fixture runner identity unavailable");
    const statusPath = join(rig.dir, "runners", `${beeId}.${view.runtime!.generation}.status.json`);
    const status = readFileSync(statusPath, "utf8");
    if (mode === "torn") writeFileSync(statusPath, "{");
    if (recover) {
      release = setTimeout(() => {
        if (mode === "torn") writeFileSync(statusPath, status);
        writeFileSync(releasePath, "");
      }, 1500);
      await daemon.stop();
    } else {
      await assert.rejects(daemon.stop(), /test daemon survivor ownership recovered/);
    }
    assert.notEqual(daemon.proc.exitCode ?? daemon.proc.signalCode, null);
    assert.deepEqual(liveRunnerHostPids(rig.dir), []);
    await waitFor(() => {
      const value = inspectProcess(nativeHost.pid);
      return value.kind === "gone" || value.kind === "present" && (value.state === "zombie" || value.birth !== nativeHost.birth);
    }, "native fixture runner exited", 4000);
  } finally {
    if (release) clearTimeout(release);
    if (daemon) await forceStopTestDaemon(daemon);
    rig.cleanup();
  }
});

test("test teardown: a daemon stand-in that keeps spawning writers into its data dir is stopped to the last process before the dir is removed", { timeout: 60_000 }, async () => {
  const rig = makeDaemonDir();
  const writer = join(rig.dir, "writer.mjs");
  const standIn = join(rig.dir, "stand-in.mjs");
  writeFileSync(writer, `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const spill = join(process.argv[2], "spill", String(process.pid));
mkdirSync(spill, { recursive: true });
const end = Date.now() + 8000;
let i = 0;
const timer = setInterval(() => { writeFileSync(join(spill, String(i++)), ""); if (Date.now() > end) clearInterval(timer); }, 5);
`);
  writeFileSync(standIn, `
import { spawn } from "node:child_process";
const [dir, writer, marker] = process.argv.slice(2);
setInterval(() => spawn(process.execPath, [writer, dir, marker], { stdio: "ignore" }), 20);
`);
  const proc = spawn(process.execPath, [standIn, rig.dir, writer, MARKER], { stdio: "ignore" });
  const handle: DaemonHandle = { dir: rig.dir, socketPath: "", storePath: "", proc, output: () => "", client: () => Promise.reject(new Error("no rpc")), kill: async () => {}, stop: async () => {} };
  const survivors = () => execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" }).split("\n").filter(line => line.includes(MARKER) && line.includes(rig.dir));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(survivors().length > 0, "the stand-in is spawning writers");
  try {
    await forceStopTestDaemon(handle);
    assert.deepEqual(survivors(), [], "every writer the stand-in spawned has exited before cleanup");
    rig.cleanup();
    assert.equal(existsSync(rig.dir), false);
  } finally {
    for (const line of survivors()) { try { process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL"); } catch {} }
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    rig.cleanup();
  }
});

// Keep an exited child as a zombie while its parent is synchronously blocked.
// This is the adopted-host shape: the observing daemon is not its wait parent.
test("runner cleanup excludes exited zombies while their wait parent is still alive", { timeout: 15_000 }, async () => {
  const rig = makeDaemonDir();
  const parent = spawn(process.execPath, ["--eval", `
    const {spawn} = require('node:child_process');
    const {readSync} = require('node:fs');
    const child = spawn(process.execPath, ['--eval', 'process.exit(0)'], {stdio:'ignore'});
    process.stdout.write(String(child.pid) + '\\n');
    readSync(0, Buffer.alloc(1), 0, 1, null);
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve, reject) => {
    parent.once("exit", () => resolve());
    parent.once("error", reject);
  });
  try {
    const pid = await new Promise<number>(resolve => parent.stdout!.once("data", chunk => resolve(Number(String(chunk).trim()))));
    await waitFor(() => { const value = inspectProcess(pid); return value.kind === "present" && value.state === "zombie"; }, "owned child exited but not waited", 5000);
    process.kill(pid, 0); // The old helper mistakes this for liveness.
    const runners = join(rig.dir, "runners");
    mkdirSync(runners);
    writeFileSync(join(runners, "owned.1.status.json"), JSON.stringify({ hostPid: pid }));
    await waitFor(() => liveRunnerHostPids(rig.dir).length === 0, "test daemon runner hosts reaped", 100);
  } finally {
    parent.stdin!.end("\n");
    await exited;
    rig.cleanup();
  }
});

test("runner cleanup retains a running host even after exited status, and excludes a reused PID with another birth", () => {
  const rig = makeDaemonDir();
  try {
    const runners = join(rig.dir, "runners");
    mkdirSync(runners);
    const file = join(runners, "owned.1.status.json");
    const birth = exactProcessBirth(process.pid);
    assert.ok(birth);
    writeFileSync(file, JSON.stringify({ hostPid: process.pid, hostBirth: birth, exited: true }));
    assert.deepEqual(liveRunnerHostPids(rig.dir), [process.pid]);
    writeFileSync(file, JSON.stringify({ hostPid: process.pid, hostBirth: process.platform === "darwin" ? "darwin:0:0" : "linux:0" }));
    assert.deepEqual(liveRunnerHostPids(rig.dir), []);
    writeFileSync(file, JSON.stringify({ hostPid: process.pid, hostBirth: "malformed" }));
    assert.deepEqual(liveRunnerHostPids(rig.dir), [process.pid]);
  } finally { rig.cleanup(); }
});
