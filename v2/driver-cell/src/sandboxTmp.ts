import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_TMP_FULL } from "../../harness/src/driver.ts";
import { SANDBOX_TMPFS_PATHS } from "./sandbox.ts";

export { SANDBOX_TMP_FULL };

export type SandboxTmpfsCap =
  | { kind: "capped"; bytes: number }
  | { kind: "uncapped"; reason: "config_null" | "bwrap_no_size" | "seatbelt" };

export interface TmpfsUsage {
  path: string;
  sizeBytes: number;
  freeBytes: number;
}

let bwrapSize: boolean | null = null;

export function bwrapSupportsSize(): boolean {
  if (bwrapSize === null) {
    const res = spawnSync("bwrap", ["--help"], { encoding: "utf8", timeout: 5_000 });
    bwrapSize = `${res.stdout ?? ""}${res.stderr ?? ""}`.includes("--size");
  }
  return bwrapSize;
}

export function sandboxTmpfsCap(
  bytes: number | null,
  osPlatform: string,
  sizeSupported: () => boolean = bwrapSupportsSize,
): SandboxTmpfsCap {
  if (osPlatform === "darwin") return { kind: "uncapped", reason: "seatbelt" };
  if (bytes === null) return { kind: "uncapped", reason: "config_null" };
  if (!sizeSupported()) return { kind: "uncapped", reason: "bwrap_no_size" };
  return { kind: "capped", bytes };
}

export function formatBytes(bytes: number): string {
  for (const [unit, size] of [["GiB", 1024 ** 3], ["MiB", 1024 ** 2], ["KiB", 1024]] as const) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size} ${unit}`;
  }
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${bytes} B`;
}

export function describeSandboxTmpfs(beeId: string, generation: number, cap: SandboxTmpfsCap): string {
  return cap.kind === "capped"
    ? `sandbox.tmpfs bee=${beeId} gen=${generation} cap=${cap.bytes} (${formatBytes(cap.bytes)}) paths=${SANDBOX_TMPFS_PATHS.join(",")}`
    : `sandbox.tmpfs bee=${beeId} gen=${generation} cap=none reason=${cap.reason}`;
}

export function sandboxTmpFullDetail(usage: TmpfsUsage): string {
  return `${SANDBOX_TMP_FULL}: ${usage.path} in this bee's sandbox is at its ${formatBytes(usage.sizeBytes)} cap (bees.sandboxTmpBytes); writes there fail with "No space left on device" until files are removed or the cap is raised`;
}

export function isSandboxTmpFullDetail(detail: string): boolean {
  return detail.startsWith(SANDBOX_TMP_FULL);
}

function mountNamespace(procRoot: string, pid: number): string | null {
  try {
    return readlinkSync(join(procRoot, String(pid), "ns", "mnt"));
  } catch {
    return null;
  }
}

function childrenOf(procRoot: string, pid: number): number[] {
  const out: number[] = [];
  let tasks: string[];
  try {
    tasks = readdirSync(join(procRoot, String(pid), "task"));
  } catch {
    return out;
  }
  for (const task of tasks) {
    try {
      for (const child of readFileSync(join(procRoot, String(pid), "task", task, "children"), "utf8").trim().split(/\s+/)) {
        if (/^\d+$/.test(child)) out.push(Number(child));
      }
    } catch {
      continue;
    }
  }
  return out;
}

export function sandboxedPid(hostPid: number, procRoot = "/proc"): number | null {
  const own = mountNamespace(procRoot, hostPid);
  if (own === null) return null;
  let pending = childrenOf(procRoot, hostPid);
  const seen = new Set<number>([hostPid]);
  for (let depth = 0; depth < 4 && pending.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of pending.slice(0, 64)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const ns = mountNamespace(procRoot, pid);
      if (ns !== null && ns !== own) return pid;
      next.push(...childrenOf(procRoot, pid));
    }
    pending = next;
  }
  return null;
}

export function sampleSandboxTmpfs(pid: number, procRoot = "/proc"): TmpfsUsage[] {
  const out: TmpfsUsage[] = [];
  for (const path of SANDBOX_TMPFS_PATHS) {
    try {
      const s = statfsSync(join(procRoot, String(pid), "root", path));
      out.push({ path, sizeBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize });
    } catch {
      continue;
    }
  }
  return out;
}

export function fullTmpfs(usage: readonly TmpfsUsage[]): TmpfsUsage | null {
  return usage.find((u) => u.sizeBytes > 0 && u.freeBytes * 64 < u.sizeBytes) ?? null;
}

export function roomyTmpfs(usage: readonly TmpfsUsage[]): boolean {
  return usage.every((u) => u.sizeBytes <= 0 || u.freeBytes * 8 >= u.sizeBytes);
}

export interface SandboxTmpEvidence {
  beeId: string;
  generation: number;
  flag: "resource_blocked";
  action: "set" | "clear";
  detail: string;
  owner: "sandbox_tmp";
}

export interface SandboxTmpWatchOptions {
  intervalMs: number;
  now?: () => number;
  sample?: (hostPid: number) => TmpfsUsage[] | null;
  log?: (op: string) => void;
}

function sampleHost(hostPid: number): TmpfsUsage[] | null {
  const pid = sandboxedPid(hostPid);
  return pid === null ? null : sampleSandboxTmpfs(pid);
}

function evidence(beeId: string, generation: number, action: "set" | "clear", detail: string): SandboxTmpEvidence {
  return { beeId, generation, flag: "resource_blocked", action, detail, owner: "sandbox_tmp" };
}

export class SandboxTmpWatch {
  private readonly tracked = new Map<string, number | null>();
  private readonly state = new Map<string, "full" | "ok">();
  private readonly exits: SandboxTmpEvidence[] = [];
  private sampledAt = Number.NEGATIVE_INFINITY;
  private readonly opts: SandboxTmpWatchOptions;

  constructor(opts: SandboxTmpWatchOptions) {
    this.opts = opts;
  }

  track(beeId: string, generation: number | null): void {
    if (generation !== null || !this.tracked.has(beeId)) this.tracked.set(beeId, generation);
  }

  exited(beeId: string, generation: number): void {
    const tracked = this.tracked.get(beeId);
    if (tracked === undefined || (tracked !== null && tracked !== generation)) return;
    this.tracked.delete(beeId);
    this.state.delete(beeId);
    this.exits.push(evidence(beeId, generation, "clear", `${SANDBOX_TMP_FULL} cleared: the sandbox tmpfs went away with its runtime`));
  }

  observe(
    live: readonly { beeId: string; generation: number; pid: number }[],
    cleared: Iterable<string>,
  ): SandboxTmpEvidence[] {
    const out = this.exits.splice(0);
    const resample = new Set<string>();
    for (const beeId of cleared) {
      if (this.state.get(beeId) === "full") {
        this.state.delete(beeId);
        resample.add(beeId);
      }
    }
    const now = (this.opts.now ?? Date.now)();
    const due = now - this.sampledAt >= this.opts.intervalMs;
    if (!due && resample.size === 0) return out;
    if (due) this.sampledAt = now;
    const sample = this.opts.sample ?? sampleHost;
    for (const proc of live) {
      if (!this.tracked.has(proc.beeId)) continue;
      if (!due && !resample.has(proc.beeId)) continue;
      const usage = sample(proc.pid);
      if (usage === null) continue;
      const known = this.state.get(proc.beeId);
      const hit = fullTmpfs(usage);
      if (hit && known !== "full") {
        this.state.set(proc.beeId, "full");
        this.opts.log?.(`sandbox.tmp_full bee=${proc.beeId} gen=${proc.generation} path=${hit.path} cap=${hit.sizeBytes} (${formatBytes(hit.sizeBytes)}) freeBytes=${hit.freeBytes}`);
        out.push(evidence(proc.beeId, proc.generation, "set", sandboxTmpFullDetail(hit)));
      } else if (!hit && known !== "ok" && roomyTmpfs(usage)) {
        this.state.set(proc.beeId, "ok");
        out.push(evidence(proc.beeId, proc.generation, "clear", `${SANDBOX_TMP_FULL} cleared: the sandbox tmpfs has space again`));
      }
    }
    return out;
  }
}
