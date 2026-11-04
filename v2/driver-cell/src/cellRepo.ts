import { Worker, isMainThread } from "node:worker_threads";
import { CellRepoRefusal, parseCellRepoInspection, parseCellRepoRequest, type CellRepoIdentity, type CellRepoInspection, type CellRepoRequest } from "./cellRepoProtocol.ts";

export function cellRepoBackend(sandboxed: boolean): "confined" | "unconfined" {
  return sandboxed ? "confined" : "unconfined";
}

export interface CellRepoOptions {
  deadlineMs?: number;
  helperPath?: string;
  unconfined: (identity: CellRepoIdentity, request: CellRepoRequest) => Promise<CellRepoInspection>;
}

export async function runCellRepoBatch(identity: CellRepoIdentity, request: CellRepoRequest, options: CellRepoOptions): Promise<CellRepoInspection> {
  const validated = parseCellRepoRequest(request);
  if (cellRepoBackend(identity.sandboxed) === "unconfined") return parseCellRepoInspection(await options.unconfined(identity, validated));
  const timeoutMs = options.deadlineMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new CellRepoRefusal("deadline");
  if (!isMainThread) {
    const { executeCellRepoBatch } = await import("./cellRepoExecutor.ts");
    try { return await executeCellRepoBatch({ identity, request: validated, timeoutMs, helperPath: options.helperPath }); }
    catch (error) { throw error instanceof CellRepoRefusal ? error : new CellRepoRefusal("invalid_repository"); }
  }
  const workerUrl = new URL(import.meta.url.endsWith(".ts") ? "./cellRepoWorker.ts" : "./cell-repo-worker.js", import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { execArgv: [], workerData: { identity, request: validated, timeoutMs, helperPath: options.helperPath } });
    let settled = false;
    const finish = (value: unknown, failure?: CellRepoRefusal, terminate = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminate) void worker.terminate();
      if (failure) reject(failure);
      else {
        try { resolve(parseCellRepoInspection(value)); } catch { reject(new CellRepoRefusal("invalid_output")); }
      }
    };
    const timer = setTimeout(() => {
      worker.postMessage("abort");
      finish(null, new CellRepoRefusal("deadline"), false);
      const reap = setTimeout(() => { void worker.terminate(); }, 2000);
      reap.unref();
    }, timeoutMs);
    worker.once("message", (message: { result?: unknown; failure?: string }) => {
      if (settled) { void worker.terminate(); return; }
      if (message.failure) finish(null, new CellRepoRefusal(message.failure === "identity_changed" ? "identity_changed" : message.failure === "invalid_repository" ? "invalid_repository" : message.failure === "deadline" ? "deadline" : "unavailable"));
      else finish(message.result);
    });
    worker.once("error", () => finish(null, new CellRepoRefusal("unavailable")));
    worker.once("exit", () => { if (!settled) finish(null, new CellRepoRefusal("unavailable")); });
  });
}
