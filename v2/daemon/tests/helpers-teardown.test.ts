import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forceStopTestDaemon, makeDaemonDir, type DaemonHandle } from "./helpers.ts";

const MARKER = "hb-teardown-writer";

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
