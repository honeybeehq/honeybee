import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { homeEnvFor } from "../../core/src/accountRecipes.ts";
import type { BeeResumeBundleRow, BeeRow, CoreStore } from "../../core/src/index.ts";
import { RESUME_BUNDLE_OBJECT_DIR, resumeBundlePath, resumeStatePaths, resumeStateScope } from "./resumeBundles.ts";
import { transcriptSegmentWorkerUrl, type ResumeBundleRequest, type ResumeBundleWorkerResult, type ResumeRestoreRequest, type ResumeRestoreWorkerResult, type TranscriptSweepRequest, type TranscriptSweepResult } from "./transcriptSegmentWorker.ts";

export interface BeeResumeSyncDeps {
  store: () => CoreStore;
  root: string;
  keyFile: string;
  keep: number;
  now: () => number;
  log: (op: string) => void;
  accountHome: (bee: BeeRow) => string | null;
  harness: (bee: BeeRow) => string;
  minIntervalMs?: number;
  orphanGraceMs?: number;
  workerUrl?: URL;
}

export interface ResumeBundlesStatus {
  enabled: boolean;
  keyFile: string;
  keyPresent: boolean;
  store: string;
  bees: number;
  bundles: number;
  bytes: number;
  objects: { objects: number; bytes: number; orphansSwept: number; measuredAt: number } | null;
}

const DEFAULT_MIN_INTERVAL_MS = 60_000;

export class BeeResumeSync {
  private readonly deps: BeeResumeSyncDeps;
  private readonly inFlight = new Map<string, Promise<BeeResumeBundleRow | null>>();
  private readonly lastAt = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly rerun = new Set<string>();
  private objectsStatus: ResumeBundlesStatus["objects"] = null;
  private stopping = false;

  constructor(deps: BeeResumeSyncDeps) {
    this.deps = deps;
  }

  get root(): string {
    return this.deps.root;
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  status(): ResumeBundlesStatus {
    const counts = this.deps.store().countBeeResumeBundles();
    return { enabled: true, keyFile: this.deps.keyFile, keyPresent: existsSync(this.deps.keyFile), store: this.deps.root, ...counts, objects: this.objectsStatus };
  }

  requestSync(beeId: string, reason: "turn_ended" | "exited" = "turn_ended"): void {
    if (this.stopping) return;
    if (this.inFlight.has(beeId)) {
      this.rerun.add(beeId);
      return;
    }
    if (reason === "exited") {
      const pending = this.timers.get(beeId);
      if (pending) {
        clearTimeout(pending);
        this.timers.delete(beeId);
      }
      void this.sync(beeId);
      return;
    }
    if (this.timers.has(beeId)) return;
    const interval = this.deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const since = this.deps.now() - (this.lastAt.get(beeId) ?? Number.NEGATIVE_INFINITY);
    if (since >= interval) {
      void this.sync(beeId);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(beeId);
      if (!this.stopping) void this.sync(beeId);
    }, interval - since);
    timer.unref();
    this.timers.set(beeId, timer);
  }

  sync(beeId: string): Promise<BeeResumeBundleRow | null> {
    const inFlight = this.inFlight.get(beeId);
    if (inFlight) return inFlight;
    const run = this.syncNow(beeId).finally(() => {
      this.inFlight.delete(beeId);
      if (this.rerun.delete(beeId)) this.requestSync(beeId);
    });
    this.inFlight.set(beeId, run);
    return run;
  }

  private runWorker<T>(request: ResumeBundleRequest | ResumeRestoreRequest | TranscriptSweepRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.deps.workerUrl ?? transcriptSegmentWorkerUrl(), { execArgv: [], workerData: request });
      let settled = false;
      worker.once("message", (message: T) => {
        settled = true;
        resolve(message);
      });
      worker.once("error", (err) => {
        if (!settled) reject(err);
        settled = true;
      });
      worker.once("exit", (code) => {
        if (!settled) reject(new Error(`resume bundle worker exited with code ${code} without a result`));
        settled = true;
      });
    });
  }

  private async syncNow(beeId: string): Promise<BeeResumeBundleRow | null> {
    const store = this.deps.store();
    const bee = store.getBee(beeId);
    if (!bee || bee.lifecycle === "deleted" || !bee.providerSessionId) return null;
    const epochRow = store.beeEpoch(beeId);
    if (epochRow.fencedAt != null) {
      this.deps.log(`bee.resume.push_skipped bee=${beeId} reason=fenced epoch=${epochRow.epoch}`);
      return null;
    }
    if (!existsSync(this.deps.keyFile)) {
      this.deps.log(`bee.resume.push_skipped bee=${beeId} reason=key_missing key_file=${this.deps.keyFile}`);
      return null;
    }
    const home = this.deps.accountHome(bee);
    const harness = this.deps.harness(bee);
    const state = resumeStatePaths(harness, home, bee.cwd, bee.providerSessionId);
    if (!state) {
      this.deps.log(`bee.resume.push_skipped bee=${beeId} reason=no_state harness=${harness} session=${bee.providerSessionId}`);
      return null;
    }
    this.lastAt.set(beeId, this.deps.now());
    const started = Date.now();
    try {
      const result = await this.runWorker<ResumeBundleWorkerResult>({ kind: "bundleResume", state, storeRoot: this.deps.root, keyFile: this.deps.keyFile, beeId, epoch: epochRow.epoch } satisfies ResumeBundleRequest);
      if (result.error != null) throw new Error(result.error);
      const bundle = result.bundle!;
      if (bundle.torn) {
        this.deps.log(`bee.resume.push_refused bee=${beeId} reason=torn ms=${Date.now() - started}`);
        return null;
      }
      const latest = store.latestBeeResumeBundle(beeId);
      if (latest && latest.digest === bundle.digest && latest.epoch === epochRow.epoch && latest.keyId === bundle.keyId) {
        if (latest.ref !== bundle.ref) rmSync(resumeBundlePath(this.deps.root, bundle.ref), { force: true });
        this.deps.log(`bee.resume.unchanged bee=${beeId} ref=${latest.ref} ms=${Date.now() - started}`);
        return latest;
      }
      const generation = store.currentRuntime(beeId)?.generation ?? 0;
      const row = store.putBeeResumeBundle({
        beeId, generation, harness, providerSessionId: bee.providerSessionId, cwd: bee.cwd, stateKey: state.stateKey, scope: resumeStateScope(harness, home),
        ref: bundle.ref, digest: bundle.digest, keyId: bundle.keyId, bytes: bundle.bytes, size: bundle.size, files: bundle.files, closedAt: this.deps.now(), epoch: epochRow.epoch,
      }, { keep: this.deps.keep });
      this.deps.log(`bee.resume.pushed bee=${beeId} harness=${harness} epoch=${epochRow.epoch} key=${bundle.keyId} ref=${bundle.ref} bytes=${bundle.bytes} size=${bundle.size} files=${bundle.files} ms=${Date.now() - started}`);
      return row;
    } catch (err) {
      this.deps.log(`bee.resume.push_failed bee=${beeId} err=${JSON.stringify(err instanceof Error ? err.message : String(err))} ms=${Date.now() - started}`);
      return null;
    }
  }

  adoptBundle(ref: string, bytes: Buffer): { created: boolean } {
    const target = resumeBundlePath(this.deps.root, ref);
    if (existsSync(target) && statSync(target).size === bytes.length) return { created: false };
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(target), `${randomUUID()}.partial`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return { created: true };
  }

  async restore(input: { beeId: string; ref: string; epoch: number; destinationRoot: string; harness: string; fromKey: string | null; toKey: string | null }): Promise<{ ok: boolean; error: string | null }> {
    const result = await this.runWorker<ResumeRestoreWorkerResult>({ kind: "restoreResume", storeRoot: this.deps.root, keyFile: this.deps.keyFile, ...input } satisfies ResumeRestoreRequest);
    return { ok: result.ok, error: result.error };
  }

  async sweepOrphans(): Promise<void> {
    const now = this.deps.now();
    const result = await this.runWorker<TranscriptSweepResult>({
      kind: "sweep", storeRoot: this.deps.root, dir: RESUME_BUNDLE_OBJECT_DIR, referenced: [...this.deps.store().listBeeResumeBundleRefs()], graceMs: this.deps.orphanGraceMs ?? 60 * 60_000, now,
    } satisfies TranscriptSweepRequest);
    if (result.error != null) throw new Error(result.error);
    this.objectsStatus = { objects: result.objects, bytes: result.bytes, orphansSwept: result.swept, measuredAt: now };
    this.deps.log(`bee.resume.objects root=${this.deps.root} objects=${result.objects} bytes=${result.bytes} orphans_swept=${result.swept}`);
  }
}

export function accountHomeOf(store: CoreStore, bee: BeeRow): string | null {
  const key = homeEnvFor(bee.agent);
  const bound = key ? bee.env[key] : undefined;
  if (bound) return bound;
  if (bee.account) return store.getAccount(bee.account)?.homePath ?? null;
  return null;
}
