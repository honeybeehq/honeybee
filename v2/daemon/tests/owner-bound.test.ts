import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { ownerBoundEnv, waitFor } from "./helpers.ts";

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

const birthOf = (pid: number) => execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim().replace(/\s+/g, " ");

function bound(t: { after: (fn: () => Promise<void> | void) => void }, birth: (owner: number) => string) {
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", env: { ...process.env, ...ownerBoundEnv(), HIVE_TEST_OWNER_PID: String(owner.pid), HIVE_TEST_OWNER_BIRTH: birth(owner.pid!) } });
  t.after(async () => {
    for (const proc of [owner, child]) if (running(proc)) proc.kill("SIGKILL");
    await waitFor(() => !running(owner) && !running(child), "owner-bound test processes exited", 10_000, 50);
  });
  return { owner, child };
}

test("owner-bound processes survive a live owner and are killed once it dies, even when they ignore SIGTERM", { timeout: 30_000 }, async t => {
  const { owner, child } = bound(t, birthOf);
  await new Promise(resolve => setTimeout(resolve, 3_000));
  assert.ok(running(child));
  owner.kill("SIGKILL");
  await waitFor(() => !running(child), "owner-bound process exited after its owner died", 8_000, 50);
});

test("owner-bound processes treat a live pid with a different birth as a dead owner", { timeout: 30_000 }, async t => {
  const { child } = bound(t, () => "Thu Jan 1 00:00:00 1970");
  await waitFor(() => !running(child), "owner-bound process exited after its owner pid was reused", 10_000, 50);
});
