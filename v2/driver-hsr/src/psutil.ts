/**
 * Exact process identity probing for cross-restart re-adoption (WP4).
 *
 * Contract §3.2: after a daemon restart, surviving runtimes are re-adopted
 * once, at boot, by pid + start-time check. The recorded identity is the
 * driver's wall-clock timestamp at spawn; the OS start time is recovered via
 * `ps -o etime=` (POSIX, locale-independent, macOS + Linux) and compared
 * within a small tolerance — `ps` rounds elapsed time to seconds and the
 * recorded stamp is taken a few ms after the actual fork.
 */
import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** True while the OS still knows the pid (signal 0 probe; EPERM counts as alive). */
export function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  return !isZombie(pid);
}

/** A Linux zombie's raw wait status from /proc, or null when unreadable or not a zombie. */
export function zombieWaitStatus(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] !== "Z") return null;
    const status = Number(fields[49]);
    return Number.isSafeInteger(status) ? status : null;
  } catch {
    return null;
  }
}

const ZOMBIE_CENSUS_INTERVAL_MS = 500;
const zombieNegatives = new Map<number, number>();
const zombiePositives = new Map<number, number>();
const zombieCensusQueue = new Set<number>();
let zombieCensusInFlight = false;

function isZombie(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
    } catch {
      return false;
    }
  }
  if (process.platform === "win32") return false;
  const now = Date.now();
  const positiveAt = zombiePositives.get(pid);
  if (positiveAt !== undefined) {
    zombiePositives.delete(pid);
    if (now - positiveAt < ZOMBIE_CENSUS_INTERVAL_MS) return true;
  }
  const checkedAt = zombieNegatives.get(pid);
  if (checkedAt === undefined || now - checkedAt >= ZOMBIE_CENSUS_INTERVAL_MS) {
    zombieCensusQueue.add(pid);
    runZombieCensus();
  }
  return false;
}

function runZombieCensus(): void {
  if (zombieCensusInFlight || zombieCensusQueue.size === 0) return;
  zombieCensusInFlight = true;
  const pids = [...zombieCensusQueue];
  zombieCensusQueue.clear();
  execFile("/bin/ps", ["-o", "pid=,stat=", "-p", pids.join(",")], { encoding: "utf8", timeout: 2_000 }, (_error, stdout) => {
    zombieCensusInFlight = false;
    const now = Date.now();
    for (const line of String(stdout ?? "").split("\n")) {
      const row = /^\s*(\d+)\s+(\S+)/.exec(line);
      if (!row) continue;
      const seen = Number(row[1]);
      if (row[2]!.startsWith("Z")) {
        zombiePositives.set(seen, now);
        zombieNegatives.delete(seen);
      } else {
        zombiePositives.delete(seen);
        zombieNegatives.set(seen, now);
      }
    }
    for (const [cached, at] of zombieNegatives) if (now - at >= ZOMBIE_CENSUS_INTERVAL_MS * 4) zombieNegatives.delete(cached);
    for (const [cached, at] of zombiePositives) if (now - at >= ZOMBIE_CENSUS_INTERVAL_MS) zombiePositives.delete(cached);
    runZombieCensus();
  });
}

/** Parse a POSIX `ps` etime value — `[[dd-]hh:]mm:ss` — into milliseconds. */
export function parseEtimeMs(etime: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const days = Number(m[1] ?? "0");
  const hours = Number(m[2] ?? "0");
  const minutes = Number(m[3] ?? "0");
  const seconds = Number(m[4] ?? "0");
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** OS start time of a live pid in epoch ms, or null when it cannot be determined. */
export function processStartTimeMs(pid: number, now: () => number = Date.now): number | null {
  const res = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  const elapsed = parseEtimeMs(res.stdout);
  if (elapsed == null) return null;
  return now() - elapsed;
}

/**
 * The exact-identity check (the CO.a8d2 lesson): a pid is only "the process we
 * recorded" when it is alive AND its OS start time matches the recorded spawn
 * stamp within tolerance. Anything else — dead, unreadable, or a recycled pid
 * with a different start time — is NOT our process.
 */
export function verifyProcessIdentity(
  pid: number,
  expectedStartedAtMs: number,
  toleranceMs = 5000,
): boolean {
  if (!pidAlive(pid)) return false;
  const start = processStartTimeMs(pid);
  if (start == null) return false;
  return Math.abs(start - expectedStartedAtMs) <= toleranceMs;
}
