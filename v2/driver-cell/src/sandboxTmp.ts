import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_TMPFS_PATHS } from "./sandbox.ts";

export const SANDBOX_TMP_FULL = "sandbox tmp full";

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
  for (const child of childrenOf(procRoot, hostPid)) {
    for (const grandchild of childrenOf(procRoot, child)) {
      const ns = mountNamespace(procRoot, grandchild);
      if (ns !== null && ns !== own) return grandchild;
    }
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

export interface SandboxTmpEvidence {
  beeId: string;
  generation: number;
  flag: "resource_blocked";
  action: "set" | "clear";
  detail: string;
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

export class SandboxTmpWatch {
  private readonly full = new Map<string, number>();
  private sampledAt = Number.NEGATIVE_INFINITY;
  private readonly opts: SandboxTmpWatchOptions;

  constructor(opts: SandboxTmpWatchOptions) {
    this.opts = opts;
  }

  observe(
    live: readonly { beeId: string; generation: number; pid: number }[],
    cleared: Iterable<string>,
  ): SandboxTmpEvidence[] {
    const resample = new Set<string>();
    for (const beeId of cleared) if (this.full.delete(beeId)) resample.add(beeId);
    const now = (this.opts.now ?? Date.now)();
    const due = now - this.sampledAt >= this.opts.intervalMs;
    if (!due && resample.size === 0) return [];
    if (due) this.sampledAt = now;
    const sample = this.opts.sample ?? sampleHost;
    const out: SandboxTmpEvidence[] = [];
    const liveIds = new Set<string>();
    for (const proc of live) {
      liveIds.add(proc.beeId);
      if (!due && !resample.has(proc.beeId)) continue;
      const usage = sample(proc.pid);
      if (usage === null) continue;
      const hit = fullTmpfs(usage);
      if (hit && !this.full.has(proc.beeId)) {
        this.full.set(proc.beeId, proc.generation);
        this.opts.log?.(`sandbox.tmp_full bee=${proc.beeId} gen=${proc.generation} path=${hit.path} cap=${hit.sizeBytes} (${formatBytes(hit.sizeBytes)}) freeBytes=${hit.freeBytes}`);
        out.push({ beeId: proc.beeId, generation: proc.generation, flag: "resource_blocked", action: "set", detail: sandboxTmpFullDetail(hit) });
      } else if (!hit && this.full.has(proc.beeId)) {
        this.full.delete(proc.beeId);
        out.push({ beeId: proc.beeId, generation: proc.generation, flag: "resource_blocked", action: "clear", detail: "sandbox tmp has space again" });
      }
    }
    if (due) {
      for (const [beeId, generation] of this.full) {
        if (liveIds.has(beeId)) continue;
        this.full.delete(beeId);
        out.push({ beeId, generation, flag: "resource_blocked", action: "clear", detail: "sandbox tmp went away with its runtime" });
      }
    }
    return out;
  }
}
