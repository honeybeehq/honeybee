import { execFileSync } from "node:child_process";
import { getPriority, setPriority } from "node:os";

export interface SchedulingSample {
  nice: number;
  priority: number | null;
  ioClass: string | null;
  demoted: boolean;
}

export interface SchedulingRepair {
  before: SchedulingSample;
  after: SchedulingSample;
  actions: string[];
  errors: string[];
}

export interface SchedulingStatus extends SchedulingSample {
  sampledAt: number;
  repairs: number;
  lastRepairAt: number | null;
  errors: string[];
}

export type SchedulingExec = (file: string, args: string[]) => string;

export interface SchedulingOptions {
  pid?: number;
  platform?: NodeJS.Platform;
  exec?: SchedulingExec;
  probeIo?: boolean;
}

export const DARWIN_TIMESHARE_PRIORITY = 31;

const defaultExec: SchedulingExec = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim().length > 0 ? stderr.trim() : error.message;
    return detail.split("\n")[0] ?? error.message;
  }
  return String(error);
}

export function parseIoClass(output: string): string | null {
  const head = output.trim().split(":")[0]?.trim().toLowerCase() ?? "";
  return head.length > 0 ? head : null;
}

export function sampleScheduling(options: SchedulingOptions = {}): SchedulingSample {
  const pid = options.pid ?? process.pid;
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  const nice = getPriority(pid);
  let priority: number | null = null;
  let ioClass: string | null = null;
  if (platform === "darwin") {
    const parsed = Number.parseInt(exec("/bin/ps", ["-o", "pri=", "-p", String(pid)]).trim(), 10);
    priority = Number.isFinite(parsed) ? parsed : null;
  } else if (platform === "linux" && options.probeIo !== false) {
    try {
      ioClass = parseIoClass(exec("ionice", ["-p", String(pid)]));
    } catch {
      ioClass = null;
    }
  }
  const demoted = nice > 0 || (priority !== null && priority < DARWIN_TIMESHARE_PRIORITY) || ioClass === "idle";
  return { nice, priority, ioClass, demoted };
}

export function promoteScheduling(options: SchedulingOptions = {}): SchedulingRepair {
  const pid = options.pid ?? process.pid;
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  const before = sampleScheduling(options);
  const actions: string[] = [];
  const errors: string[] = [];
  if (!before.demoted) return { before, after: before, actions, errors };
  if (platform === "darwin" && before.priority !== null && before.priority < DARWIN_TIMESHARE_PRIORITY) {
    try {
      exec("/usr/sbin/taskpolicy", ["-B", "-p", String(pid)]);
      actions.push("taskpolicy -B");
    } catch (error) {
      errors.push(`taskpolicy -B: ${errorText(error)}`);
    }
  }
  if (before.nice > 0) {
    try {
      setPriority(pid, 0);
      actions.push("setpriority 0");
    } catch (error) {
      errors.push(`setpriority 0: ${errorText(error)}`);
    }
  }
  if (before.ioClass === "idle") {
    try {
      exec("ionice", ["-c", "2", "-p", String(pid)]);
      actions.push("ionice best-effort");
    } catch (error) {
      errors.push(`ionice best-effort: ${errorText(error)}`);
    }
  }
  return { before, after: sampleScheduling(options), actions, errors };
}

export function describeScheduling(sample: SchedulingSample): string {
  const parts = [`nice ${sample.nice}`];
  if (sample.priority !== null) parts.unshift(`pri ${sample.priority}`);
  if (sample.ioClass !== null) parts.push(`io ${sample.ioClass}`);
  return parts.join(", ");
}

export function describeRepair(repair: SchedulingRepair): string {
  if (!repair.before.demoted) return `foreground (${describeScheduling(repair.before)})`;
  const via = repair.actions.length > 0 ? ` via ${repair.actions.join(" + ")}` : "";
  const failed = repair.errors.length > 0 ? `; ${repair.errors.join("; ")}` : "";
  const outcome = repair.after.demoted ? "still demoted" : "repaired";
  return `${outcome} ${describeScheduling(repair.before)} -> ${describeScheduling(repair.after)}${via}${failed}`;
}

export class ForegroundScheduling {
  private readonly options: SchedulingOptions;
  private readonly now: () => number;
  private lastRepair: SchedulingRepair;
  private status: SchedulingStatus;

  constructor(options: SchedulingOptions = {}, now: () => number = Date.now) {
    this.options = options;
    this.now = now;
    this.lastRepair = promoteScheduling(options);
    this.status = this.statusFrom(this.lastRepair, { repairs: 0, lastRepairAt: null });
  }

  describe(): string {
    return describeRepair(this.lastRepair);
  }

  check(): string | null {
    const sample = sampleScheduling(this.options);
    if (!sample.demoted) {
      this.status = { ...this.status, ...sample, sampledAt: this.now(), errors: [] };
      return null;
    }
    this.lastRepair = promoteScheduling(this.options);
    this.status = this.statusFrom(this.lastRepair, this.status);
    return `demoted again; ${describeRepair(this.lastRepair)}`;
  }

  current(): SchedulingStatus {
    return this.status;
  }

  private statusFrom(repair: SchedulingRepair, previous: { repairs: number; lastRepairAt: number | null }): SchedulingStatus {
    const at = this.now();
    const repaired = repair.before.demoted;
    return {
      ...repair.after,
      sampledAt: at,
      repairs: previous.repairs + (repaired ? 1 : 0),
      lastRepairAt: repaired ? at : previous.lastRepairAt,
      errors: repair.errors,
    };
  }
}
