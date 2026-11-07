import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { execFileSync } from "node:child_process";

function zombies(): number {
  return execFileSync("ps", ["-axo", "ppid=,stat="], { encoding: "utf8" }).split("\n").filter(line => {
    const [parent, state] = line.trim().split(/\s+/);
    return Number(parent) === process.pid && state?.startsWith("Z");
  }).length;
}

test("mirror heartbeat is reaped before its spawning worker exits", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const before = zombies();
  const upstream = new URL("../src/upstream.ts", import.meta.url).href;
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(`import {holdMirrorLock} from ${JSON.stringify(upstream)}; holdMirrorLock('/nonexistent-fixture-lock', 1000).release();`, { eval: true });
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
    });
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(zombies(), before, "short-lived workers must not abandon heartbeat child wait handles");
});

test("terminating a refresh worker cannot abandon an OS heartbeat child", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const before = zombies();
  const upstream = new URL("../src/upstream.ts", import.meta.url).href;
  for (let i = 0; i < 20; i++) {
    const worker = new Worker(`import {parentPort} from 'node:worker_threads'; import {holdMirrorLock} from ${JSON.stringify(upstream)}; const held=holdMirrorLock('/nonexistent-fixture-lock',1000); parentPort.postMessage('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`, { eval: true });
    await new Promise<void>((resolve, reject) => { worker.once("message", () => resolve()); worker.once("error", reject); });
    await worker.terminate();
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(zombies(), before, "forced owner teardown must not create zombie children");
});
