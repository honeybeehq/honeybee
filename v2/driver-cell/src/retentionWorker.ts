/**
 * Worker entrypoint for the retention pass: `inspectCellWrapper` over many
 * wrappers (git status + HEAD + a full du walk each) is seconds-to-minutes of
 * blocking work on a large cells root, so the daemon runs it here, off the
 * RPC lane, and applies the resulting plan on the main thread.
 */
import { parentPort, workerData } from "node:worker_threads";
import { inspectCellWrapper, type CellWrapperInspection } from "./retention.ts";

export interface RetentionWorkerRequest {
  wrappers: Array<{ key: string; wrapperDir: string }>;
  measure: boolean;
}

export interface RetentionWorkerResult {
  inspections: Array<{ key: string; inspection: CellWrapperInspection | null; error: string | null }>;
}

const request = workerData as RetentionWorkerRequest;
const inspections: RetentionWorkerResult["inspections"] = [];
for (const { key, wrapperDir } of request.wrappers) {
  try {
    inspections.push({ key, inspection: inspectCellWrapper(wrapperDir, { measure: request.measure }), error: null });
  } catch (err) {
    inspections.push({ key, inspection: null, error: err instanceof Error ? err.message : String(err) });
  }
}
parentPort?.postMessage({ inspections } satisfies RetentionWorkerResult);
