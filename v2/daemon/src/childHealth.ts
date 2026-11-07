import { execFile } from "node:child_process";

export const ZOMBIE_CHILD_THRESHOLD = 3;
export type ChildHealth =
  | { state: "unchecked" }
  | { state: "unavailable"; checkedAt: number }
  | { state: "ok" | "warning"; checkedAt: number; zombies: number; threshold: number };

/** Only parent PID and state: never command arguments or environments. */
export function countZombieChildren(listing: string, parentPid: number): number {
  return listing.split("\n").filter(line => {
    const [parent, state] = line.trim().split(/\s+/);
    return Number(parent) === parentPid && state?.startsWith("Z");
  }).length;
}

export function readZombieChildren(pid: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "ppid=,stat="], { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(countZombieChildren(stdout, pid));
    });
  });
}

/** One bounded census per minute, with no overlapping subprocesses. */
export class ChildHealthMonitor {
  status: ChildHealth = { state: "unchecked" };
  private pending: Promise<void> | null = null;
  private readonly log: (line: string) => void;
  private readonly read: () => Promise<number>;
  constructor(log: (line: string) => void, read = () => readZombieChildren(process.pid)) {
    this.log = log;
    this.read = read;
  }

  check(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.read().then(zombies => {
      this.status = { state: zombies > ZOMBIE_CHILD_THRESHOLD ? "warning" : "ok", checkedAt: Date.now(), zombies, threshold: ZOMBIE_CHILD_THRESHOLD };
      if (this.status.state === "warning") this.log(`daemon.children.zombies warning count=${zombies} threshold=${ZOMBIE_CHILD_THRESHOLD} pid=${process.pid}`);
    }, () => {
      this.status = { state: "unavailable", checkedAt: Date.now() };
      this.log("daemon.children.census_unavailable");
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
