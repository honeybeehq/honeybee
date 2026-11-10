import { Worker } from "node:worker_threads";
import { basename, dirname, join } from "node:path";
import type { UnresolvedRuntime } from "./identityRecovery.ts";
import type { LocalTrustConfig } from "./localRpcTrust.ts";
import type { TranscriptSegmentsResult } from "./protocol.ts";

export interface ReadWorkerData {
  storePath: string;
  socketPath: string;
  dataDir: string;
  instance: { id: string; dataDir: string };
  localTrust: LocalTrustConfig;
  transcriptStore: TranscriptSegmentsResult["store"];
  strictConfinement: boolean;
  identity: UnresolvedRuntime[];
}

export type ReadWorkerCommand =
  | { type: "confinement"; strict: boolean }
  | { type: "identity"; rows: UnresolvedRuntime[] }
  | { type: "close" };

export type ReadWorkerEvent =
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "audit"; kind: string; payload: Record<string, unknown> }
  | { type: "log"; op: string };

export interface ReadServerHooks {
  audit(kind: string, payload: Record<string, unknown>): void;
  log(op: string): void;
  lost(reason: string): void;
}

const START_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 3_000;

export function readSocketPath(socketPath: string): string {
  const name = basename(socketPath);
  return join(dirname(socketPath), name.endsWith(".sock") ? `${name.slice(0, -".sock".length)}.read.sock` : `${name}.read`);
}

export function readWorkerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("./readWorker.ts", import.meta.url)
    : new URL("./read-worker.js", import.meta.url);
}

export class ReadServer {
  readonly socketPath: string;
  private readonly worker: Worker;
  private closing: Promise<void> | null = null;

  private constructor(worker: Worker, socketPath: string) {
    this.worker = worker;
    this.socketPath = socketPath;
  }

  static start(data: ReadWorkerData, hooks: ReadServerHooks, workerUrl: URL = readWorkerUrl()): Promise<ReadServer> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl, { execArgv: [], workerData: data });
      let server: ReadServer | null = null;
      let settled = false;
      const refuse = (reason: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        reject(new Error(reason));
      };
      const timer = setTimeout(() => refuse("read worker did not start in time"), START_TIMEOUT_MS);
      timer.unref();
      worker.on("message", (event: ReadWorkerEvent) => {
        if (event.type === "audit") hooks.audit(event.kind, event.payload);
        else if (event.type === "log") hooks.log(event.op);
        else if (event.type === "failed") refuse(event.message);
        else if (!settled) {
          settled = true;
          clearTimeout(timer);
          worker.unref();
          server = new ReadServer(worker, data.socketPath);
          resolve(server);
        }
      });
      worker.on("error", (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        if (server) hooks.lost(reason);
        else refuse(reason);
      });
      worker.on("exit", (code) => {
        if (server && server.closing === null) hooks.lost(`exit ${code}`);
        else if (!server) refuse(`read worker exited ${code}`);
      });
    });
  }

  setStrictConfinement(strict: boolean): void {
    this.send({ type: "confinement", strict });
  }

  setIdentity(rows: UnresolvedRuntime[]): void {
    this.send({ type: "identity", rows });
  }

  close(): Promise<void> {
    return this.closing ??= new Promise((resolve) => {
      const timer = setTimeout(() => void this.worker.terminate(), CLOSE_TIMEOUT_MS);
      this.worker.once("exit", () => { clearTimeout(timer); resolve(); });
      this.send({ type: "close" });
    });
  }

  private send(command: ReadWorkerCommand): void {
    this.worker.postMessage(command);
  }
}
