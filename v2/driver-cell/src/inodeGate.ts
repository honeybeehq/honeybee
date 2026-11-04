import { Worker } from "node:worker_threads";
import { CellStorageRefused, type CellStorageIdentity, type CellStorageScan } from "./inodeScan.ts";

type Pass = CellStorageIdentity & {independentInodes: boolean; validationEpoch: number};
interface Request {
  key: string;
  identity: CellStorageIdentity;
  epoch: number;
  resolve(value: Pass): void;
  reject(error: Error): void;
}

export class CellStorageGate {
  private readonly passes = new Map<string, {signature: string; epoch: number}>();
  private readonly signatures = new Map<string, string>();
  private readonly epochs = new Map<string, number>();
  private readonly pending = new Map<string, Promise<Pass>>();
  private readonly queue: Request[] = [];
  private active: Worker | null = null;
  private closed = false;
  private readonly maxEntries: number;
  private readonly timeoutMs: number;
  private readonly onResult?: (key: string, result: CellStorageScan | Error) => void;

  constructor(options: {maxEntries?: number; timeoutMs?: number; onResult?: (key: string, result: CellStorageScan | Error) => void} = {}) {
    this.maxEntries = options.maxEntries ?? 250000;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.onResult = options.onResult;
  }

  invalidate(key: string): void {
    this.passes.delete(key);
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
  }

  isCurrent(key: string, pass: Pass): boolean {
    return pass.validationEpoch === (this.epochs.get(key) ?? 0) && (!pass.sandboxed || this.passes.get(key)?.signature === JSON.stringify([pass.cellsRoot, pass.wrapper, pass.spaceDir, true]));
  }

  obtainValidatedCellGitIdentity(key: string, identity: CellStorageIdentity): Promise<Pass> {
    if (this.closed) return Promise.reject(new CellStorageRefused("validation service is closed"));
    const signature = JSON.stringify([identity.cellsRoot, identity.wrapper, identity.spaceDir, identity.sandboxed]);
    if (this.signatures.get(key) !== signature) {
      this.invalidate(key);
      this.signatures.set(key, signature);
    }
    const epoch = this.epochs.get(key) ?? 0;
    if (!identity.sandboxed) return Promise.resolve({...identity, independentInodes: false, validationEpoch: epoch});
    const pass = this.passes.get(key);
    if (pass?.signature === signature && pass.epoch === epoch) return Promise.resolve({...identity, independentInodes: true, validationEpoch: epoch});
    const pendingKey = JSON.stringify([key, signature, epoch]);
    const existing = this.pending.get(pendingKey);
    if (existing) return existing;
    const result = new Promise<Pass>((resolve, reject) => {
      this.queue.push({key, identity: {...identity}, epoch, resolve, reject});
    });
    this.pending.set(pendingKey, result);
    void result.finally(() => this.pending.delete(pendingKey)).catch(() => {});
    this.drain();
    return result;
  }

  close(): void {
    this.closed = true;
    this.passes.clear();
    for (const request of this.queue.splice(0)) request.reject(new CellStorageRefused("validation service is closed"));
    void this.active?.terminate();
  }

  private drain(): void {
    if (this.active || this.closed) return;
    const request = this.queue.shift();
    if (!request) return;
    const url = import.meta.url.endsWith(".ts") ? new URL("./inodeWorker.ts", import.meta.url) : new URL("./inode-worker.js", import.meta.url);
    let worker: Worker;
    try { worker = new Worker(url, {execArgv: [], workerData: {identity: request.identity, maxEntries: this.maxEntries, timeoutMs: this.timeoutMs}}); }
    catch { request.reject(new CellStorageRefused("validation worker could not start")); this.drain(); return; }
    this.active = worker;
    let settled = false;
    const finish = (result: CellStorageScan | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stale = this.closed || request.epoch !== (this.epochs.get(request.key) ?? 0);
      if (stale) request.reject(new CellStorageRefused("stored identity or policy changed during validation"));
      else if (result instanceof Error) request.reject(result);
      else {
        this.passes.set(request.key, {signature: JSON.stringify([request.identity.cellsRoot, request.identity.wrapper, request.identity.spaceDir, true]), epoch: request.epoch});
        request.resolve({...request.identity, independentInodes: true, validationEpoch: request.epoch});
      }
      try { this.onResult?.(request.key, result); } catch {}
      void worker.terminate().finally(() => { this.active = null; this.drain(); });
    };
    const timer = setTimeout(() => finish(new CellStorageRefused("validation deadline exceeded")), this.timeoutMs);
    worker.once("message", (message: {ok: boolean; result?: CellStorageScan; error?: string}) => finish(message.ok && message.result ? message.result : new CellStorageRefused(message.error ?? "validation worker refused storage")));
    worker.once("error", () => finish(new CellStorageRefused("validation worker failed")));
    worker.once("exit", () => { if (!settled) finish(new CellStorageRefused("validation worker exited without a result")); });
  }
}
