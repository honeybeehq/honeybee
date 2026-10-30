/**
 * Worker entrypoint for the retention pass: `inspectCellWrapper` over many
 * wrappers (git status + HEAD + a full du walk each) is seconds-to-minutes of
 * blocking work on a large cells root, so the daemon runs it here, off the
 * RPC lane, and applies the resulting plan on the main thread.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { LandingReceipt } from "./landed.ts";
import { inspectCellWrapper, verifyParkPaths, type CellWrapperInspection, type ParkMode, type TrimSkip } from "./retention.ts";
import { refreshUpstreamMirror, type UpstreamRef } from "./upstream.ts";

export interface RetentionWorkerRequest {
  kind?: "inspect";
  wrappers: Array<{ key: string; wrapperDir: string; receipts?: LandingReceipt[]; originRepo?: string | null }>;
  measure: boolean;
  trimPatterns: string[];
  /** Refresh each origin's upstream mirror before inspecting; its ref counts as landed by ancestry. */
  upstream?: { root: string; maxAgeMs: number; timeoutMs: number } | null;
  /** Post a `RetentionWorkerProgress` message after each wrapper. */
  progress?: boolean;
}

export interface RetentionWorkerInspection {
  key: string;
  inspection: CellWrapperInspection | null;
  error: string | null;
}

export interface RetentionUpstreamStatus {
  originRepo: string;
  status: "fetched" | "fresh" | "unmirrored" | "failed";
  url: string | null;
  ref: UpstreamRef | null;
  error: string | null;
}

export interface RetentionWorkerProgress {
  kind: "progress";
  inspection: RetentionWorkerInspection;
}

export interface RetentionWorkerResult {
  kind?: "result";
  inspections: RetentionWorkerInspection[];
  upstreams?: RetentionUpstreamStatus[];
}

export interface TrimVerifyWorkerRequest {
  kind: "verifyTrim";
  cells: Array<{ key: string; wrapperDir: string; paths: string[]; modifiedSinceMs: number }>;
  trimPatterns: string[];
  /** What parking removes; absent = the trim patterns alone. */
  mode?: ParkMode;
}

export interface TrimVerifyWorkerResult {
  verified: Array<{ key: string; confirmed: string[]; skipped: TrimSkip[]; shallow: string[]; error: string | null }>;
}

const request = workerData as RetentionWorkerRequest | TrimVerifyWorkerRequest;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
if (request.kind === "verifyTrim") {
  const verified: TrimVerifyWorkerResult["verified"] = [];
  for (const { key, wrapperDir, paths, modifiedSinceMs } of request.cells) {
    try {
      verified.push({ key, ...verifyParkPaths(wrapperDir, paths, request.mode ?? "trim", { trimPatterns: request.trimPatterns, modifiedSinceMs }), error: null });
    } catch (err) {
      verified.push({ key, confirmed: [], skipped: [], shallow: [], error: errorText(err) });
    }
  }
  parentPort?.postMessage({ verified } satisfies TrimVerifyWorkerResult);
} else {
  const upstreams = new Map<string, RetentionUpstreamStatus>();
  if (request.upstream) {
    for (const originRepo of new Set(request.wrappers.map((w) => w.originRepo).filter((o): o is string => typeof o === "string"))) {
      try {
        const refreshed = refreshUpstreamMirror(originRepo, request.upstream.root, { maxAgeMs: request.upstream.maxAgeMs, timeoutMs: request.upstream.timeoutMs });
        upstreams.set(originRepo, { originRepo, status: refreshed.status, url: refreshed.url, ref: refreshed.ref, error: refreshed.status === "failed" ? refreshed.error : null });
      } catch (err) {
        upstreams.set(originRepo, { originRepo, status: "failed", url: null, ref: null, error: errorText(err) });
      }
    }
  }
  const inspections: RetentionWorkerInspection[] = [];
  for (const { key, wrapperDir, receipts, originRepo } of request.wrappers) {
    let entry: RetentionWorkerInspection;
    try {
      const upstream = originRepo ? upstreams.get(originRepo)?.ref ?? null : null;
      entry = { key, inspection: inspectCellWrapper(wrapperDir, { measure: request.measure, trimPatterns: request.trimPatterns, receipts, upstream }), error: null };
    } catch (err) {
      entry = { key, inspection: null, error: errorText(err) };
    }
    inspections.push(entry);
    if (request.progress) parentPort?.postMessage({ kind: "progress", inspection: entry } satisfies RetentionWorkerProgress);
  }
  parentPort?.postMessage({ kind: "result", inspections, upstreams: [...upstreams.values()] } satisfies RetentionWorkerResult);
}
