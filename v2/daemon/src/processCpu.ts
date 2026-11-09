import { availableParallelism } from "node:os";

export const PROCESS_CPU_SAMPLE_MS = 5_000;
export const PROCESS_CPU_WINDOW_MS = 60_000;

export interface ProcessCpu {
  schema: 1;
  percent: number;
  windowMs: number;
  sampledAt: number;
  cores: number;
}

interface Sample { at: number; wallNs: bigint; cpuMicros: number }

export class ProcessCpuMeter {
  private readonly samples: Sample[] = [];
  private readonly windowMs: number;
  private readonly read: () => NodeJS.CpuUsage;
  private readonly clock: () => bigint;
  private readonly now: () => number;

  constructor(options: { windowMs?: number; read?: () => NodeJS.CpuUsage; clock?: () => bigint; now?: () => number } = {}) {
    this.windowMs = options.windowMs ?? PROCESS_CPU_WINDOW_MS;
    this.read = options.read ?? (() => process.cpuUsage());
    this.clock = options.clock ?? (() => process.hrtime.bigint());
    this.now = options.now ?? (() => Date.now());
  }

  sample(): void {
    const usage = this.read();
    const next: Sample = { at: this.now(), wallNs: this.clock(), cpuMicros: usage.user + usage.system };
    this.samples.push(next);
    while (this.samples.length > 2 && Number(next.wallNs - this.samples[1]!.wallNs) >= this.windowMs * 1e6) this.samples.shift();
  }

  status(): ProcessCpu | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const wallMicros = Number(last.wallNs - first.wallNs) / 1e3;
    if (wallMicros <= 0) return null;
    const percent = Math.max(0, Math.round(((last.cpuMicros - first.cpuMicros) / wallMicros) * 1000) / 10);
    return { schema: 1, percent, windowMs: Math.round(wallMicros / 1e3), sampledAt: last.at, cores: availableParallelism() };
  }
}
