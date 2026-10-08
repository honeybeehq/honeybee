/**
 * Worker entrypoint for the retention pass: `inspectCellWrapper` over many
 * wrappers (git status + HEAD + a full du walk each) is seconds-to-minutes of
 * blocking work on a large cells root, so the daemon runs it here, off the
 * RPC lane, and applies the resulting plan on the main thread.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { LandingReceipt } from "./landed.ts";
import { inspectCellWrapper, verifyTrimPaths, type CellWrapperInspection, type TrimSkip } from "./retention.ts";

export interface RetentionWorkerRequest {
  kind?: "inspect";
  wrappers: Array<{ key: string; wrapperDir: string; receipts?: LandingReceipt[] }>;
  measure: boolean;
  trimPatterns: string[];
}

export interface RetentionWorkerResult {
  inspections: Array<{ key: string; inspection: CellWrapperInspection | null; error: string | null }>;
}

export interface TrimVerifyWorkerRequest {
  kind: "verifyTrim";
  cells: Array<{ key: string; wrapperDir: string; paths: string[]; modifiedSinceMs: number }>;
  trimPatterns: string[];
}

export interface TrimVerifyWorkerResult {
  verified: Array<{ key: string; confirmed: string[]; skipped: TrimSkip[]; error: string | null }>;
}

const request = workerData as RetentionWorkerRequest | TrimVerifyWorkerRequest;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
if (request.kind === "verifyTrim") {
  const verified: TrimVerifyWorkerResult["verified"] = [];
  for (const { key, wrapperDir, paths, modifiedSinceMs } of request.cells) {
    try {
      verified.push({ key, ...verifyTrimPaths(wrapperDir, paths, { trimPatterns: request.trimPatterns, modifiedSinceMs }), error: null });
    } catch (err) {
      verified.push({ key, confirmed: [], skipped: [], error: errorText(err) });
    }
  }
  parentPort?.postMessage({ verified } satisfies TrimVerifyWorkerResult);
} else {
  const inspections: RetentionWorkerResult["inspections"] = [];
  for (const { key, wrapperDir, receipts } of request.wrappers) {
    try {
      inspections.push({ key, inspection: inspectCellWrapper(wrapperDir, { measure: request.measure, trimPatterns: request.trimPatterns, receipts }), error: null });
    } catch (err) {
      inspections.push({ key, inspection: null, error: errorText(err) });
    }
  }
  parentPort?.postMessage({ inspections } satisfies RetentionWorkerResult);
}
