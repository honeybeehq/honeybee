import type { StoreUpgradeProgress } from "../../core/src/storeUpgrade.ts";
import { PROTOCOL, type DaemonBootPhase, type DaemonReadyBoot, type DaemonStartingBoot, type StartingHealthResult } from "./protocol.ts";

export const VERIFY_TO_BACKUP_TIME_RATIOS: ReadonlyArray<readonly [bytes: number, ratio: number]> = [
  [400_000_000, 5.0],
  [1_300_000_000, 5.9],
  [3_000_000_000, 6.2],
];

export function verifyToBackupTimeRatio(bytes: number): number {
  const table = VERIFY_TO_BACKUP_TIME_RATIOS;
  if (bytes <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i++) {
    const [upperBytes, upperRatio] = table[i]!;
    if (bytes > upperBytes) continue;
    const [lowerBytes, lowerRatio] = table[i - 1]!;
    const position = Math.log(bytes / lowerBytes) / Math.log(upperBytes / lowerBytes);
    return lowerRatio + position * (upperRatio - lowerRatio);
  }
  return table[table.length - 1]![1];
}
export const ETA_MIN_ELAPSED_MS = 2_000;
export const ETA_MIN_FRACTION = 0.02;

interface PhaseFacts {
  phase: DaemonBootPhase;
  phaseStartedAt: number;
  bytesDone: number | null;
  bytesTotal: number | null;
}

export class BootStatus {
  private facts: PhaseFacts;
  private schema: { schemaFrom: number | null; schemaTo: number | null } = { schemaFrom: null, schemaTo: null };
  private backupStartedAt: number | null = null;
  private backupElapsedMs: number | null = null;
  private storeBytes: number | null = null;
  private readyAt: number | null = null;

  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(startedAt: number, now: () => number = Date.now) {
    this.startedAt = startedAt;
    this.now = now;
    this.facts = { phase: "boot_reconcile", phaseStartedAt: now(), bytesDone: null, bytesTotal: null };
  }

  storeProgress(progress: StoreUpgradeProgress): void {
    const now = this.now();
    this.schema = { schemaFrom: progress.schemaFrom, schemaTo: progress.schemaTo };
    if (progress.phase === "store_backup" && this.backupStartedAt === null) this.backupStartedAt = now;
    if (progress.bytesTotal !== null) this.storeBytes = progress.bytesTotal;
    if (progress.phase !== "store_backup" && this.backupStartedAt !== null && this.backupElapsedMs === null) this.backupElapsedMs = now - this.backupStartedAt;
    const phaseStartedAt = progress.phase === this.facts.phase ? this.facts.phaseStartedAt : now;
    this.facts = { phase: progress.phase, phaseStartedAt, bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal };
  }

  reconciling(): void {
    this.facts = { phase: "boot_reconcile", phaseStartedAt: this.now(), bytesDone: null, bytesTotal: null };
  }

  ready(): void {
    this.readyAt = this.now();
  }

  get readyBoot(): DaemonReadyBoot {
    return { state: "ready", readyAt: this.readyAt ?? this.now() };
  }

  starting(): DaemonStartingBoot | null {
    if (this.readyAt !== null) return null;
    const { phase, phaseStartedAt, bytesDone, bytesTotal } = this.facts;
    const progress = bytesDone !== null && bytesTotal !== null && bytesTotal > 0
      ? { bytesDone, bytesTotal, fraction: Math.min(1, bytesDone / bytesTotal) }
      : null;
    return { state: "starting", phase, phaseStartedAt, ...(phase === "boot_reconcile" ? { schemaFrom: null, schemaTo: null } : this.schema), progress, etaMs: this.etaMs(progress?.fraction ?? null) };
  }

  startingHealth(): StartingHealthResult | null {
    const boot = this.starting();
    if (!boot) return null;
    const now = this.now();
    return { protocol: PROTOCOL, pid: process.pid, startedAt: this.startedAt, uptimeMs: now - this.startedAt, boot };
  }

  private verifyRatio(): number {
    return verifyToBackupTimeRatio(this.storeBytes ?? 0);
  }

  private etaMs(fraction: number | null): number | null {
    const now = this.now();
    if (this.facts.phase === "store_backup") {
      if (this.backupStartedAt === null || fraction === null) return null;
      const elapsed = now - this.backupStartedAt;
      if (elapsed < ETA_MIN_ELAPSED_MS || fraction < ETA_MIN_FRACTION) return null;
      const projectedBackupMs = elapsed / fraction;
      return Math.round(projectedBackupMs - elapsed + this.verifyRatio() * projectedBackupMs);
    }
    if (this.facts.phase === "store_backup_verify") {
      if (this.backupElapsedMs === null) return null;
      const remaining = this.verifyRatio() * this.backupElapsedMs - (now - this.facts.phaseStartedAt);
      return remaining > 0 ? Math.round(remaining) : null;
    }
    return null;
  }
}
