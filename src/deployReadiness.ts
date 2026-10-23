export type DeployProcessIdentity = { pid: number; birth: string; bootId: string };
export type DeployReadinessObservation = {
  ready: boolean;
  repair?: boolean;
  process?: DeployProcessIdentity;
  processGone?: boolean;
  progress: string;
};

export class DeployReadinessError extends Error {
  constructor(readonly code: "READINESS_REPAIR" | "READINESS_EXITED" | "READINESS_IDENTITY_CHANGED" | "READINESS_LIMIT" | "READINESS_STALLED", message: string, readonly processIdentity?: DeployProcessIdentity) {
    super(message);
    this.name = "DeployReadinessError";
  }
}

export async function waitForDeployReadiness(options: {
  observe: () => Promise<DeployReadinessObservation>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  stallMs?: number;
  hardCapMs?: number;
  onProgress?: (identity: DeployProcessIdentity, elapsedMs: number) => void;
}): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now();
  let progressedAt = started;
  let identity: DeployProcessIdentity | undefined;
  let progress: string | undefined;
  while (true) {
    const observed = await options.observe();
    if (observed.repair) throw new DeployReadinessError("READINESS_REPAIR", "deploy: daemon held, needs Node pin repair", identity);
    if (identity && observed.processGone) throw new DeployReadinessError("READINESS_EXITED", "deploy: startup process exited before readiness", identity);
    if (observed.process) {
      if (identity && (identity.pid !== observed.process.pid || identity.birth !== observed.process.birth || identity.bootId !== observed.process.bootId)) throw new DeployReadinessError("READINESS_IDENTITY_CHANGED", "deploy: startup process identity changed", identity);
      identity ??= observed.process;
      if (progress !== observed.progress) {
        progress = observed.progress;
        progressedAt = now();
        options.onProgress?.(identity, progressedAt - started);
      }
    }
    if (observed.ready) return;
    if (now() - started >= (options.hardCapMs ?? 15 * 60_000)) throw new DeployReadinessError("READINESS_LIMIT", "deploy: startup exceeded its total readiness limit", identity);
    if (now() - progressedAt >= (options.stallMs ?? 60_000)) throw new DeployReadinessError("READINESS_STALLED", "deploy: startup made no verifiable progress within the stall limit", identity);
    await sleep(options.pollMs ?? 100);
  }
}
