import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const [ownerArg, root, leaseDir] = process.argv.slice(2);
const ownerPid = Number(ownerArg);
const pollMs = Number(process.env.HIVE_FIXTURE_WARDEN_POLL_MS ?? 100);

if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !root || !leaseDir) {
  throw new Error("usage: fixture-warden.mjs <owner-pid> <gate-root> <lease-dir>");
}

async function snapshot() {
  const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,ppid=,pgid=,lstart=,args="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  const rows = new Map();
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const pid = Number(fields[0]);
    rows.set(pid, { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), birth: fields.slice(3, 8).join(" "), args: fields.slice(8).join(" ") });
  }
  return rows;
}

const owned = new Map();
const ownedGroups = new Map();
let ownerBirth;

function sameProcess(rows, pid, birth) {
  return rows.get(pid)?.birth === birth;
}

function claim(row) {
  owned.set(row.pid, row.birth);
  if (row.pid === row.pgid) ownedGroups.set(row.pgid, row.birth);
}

function track(rows) {
  for (const [pid, birth] of owned) if (!sameProcess(rows, pid, birth)) owned.delete(pid);
  for (const [pgid, birth] of ownedGroups) {
    const leader = rows.get(pgid);
    if (leader !== undefined && leader.birth !== birth) ownedGroups.delete(pgid);
    else if (leader === undefined && ![...rows.values()].some(row => row.pgid === pgid)) ownedGroups.delete(pgid);
  }
  for (;;) {
    const before = owned.size;
    for (const row of rows.values()) {
      if (row.pid === process.pid || row.pid === ownerPid || owned.has(row.pid)) continue;
      if (owned.has(row.ppid) || ownedGroups.has(row.pgid)) claim(row);
    }
    if (owned.size === before) break;
  }
}

function adopt(rows, pid) {
  const row = rows.get(pid);
  if (row !== undefined && row.ppid === ownerPid && sameProcess(rows, ownerPid, ownerBirth)) claim(row);
}

async function sweep() {
  const reaped = new Map();
  rmSync(leaseDir, { recursive: true, force: true });
  for (let round = 0; round < 40; round += 1) {
    const rows = await snapshot();
    track(rows);
    const live = [...owned].filter(([pid, birth]) => sameProcess(rows, pid, birth));
    if (live.length === 0) break;
    for (const [pid] of live) {
      try {
        process.kill(pid, "SIGKILL");
        if (!reaped.has(pid)) reaped.set(pid, rows.get(pid).args);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return [...reaped].map(([pid, args]) => ({ pid, args }));
}

let sweeping;
function finish() {
  sweeping ??= sweep().then(reaped => {
    if (process.connected) process.send({ type: "swept", reaped }, () => process.exit(0));
    else process.exit(0);
  });
  return sweeping;
}

let adopting = Promise.resolve();
process.on("message", message => {
  if (message?.type === "sweep") adopting.then(() => finish());
  if (message?.type === "adopt" && Number.isSafeInteger(message.pid)) {
    adopting = adopting.then(async () => {
      adopt(await snapshot(), message.pid);
      if (process.connected) process.send({ type: "adopted", pid: message.pid });
    });
  }
});
process.on("disconnect", () => void finish());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void finish());

const initial = await snapshot();
ownerBirth = initial.get(ownerPid)?.birth;
if (ownerBirth === undefined) process.exit(0);
process.send({ type: "ready" });

while (sweeping === undefined) {
  await new Promise(resolve => setTimeout(resolve, pollMs));
  await adopting;
  if (sweeping !== undefined) break;
  const rows = await snapshot();
  if (sweeping !== undefined) break;
  track(rows);
  if (!sameProcess(rows, ownerPid, ownerBirth) || !process.connected || !existsSync(root)) await finish();
}
