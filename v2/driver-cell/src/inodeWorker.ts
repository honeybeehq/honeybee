import { parentPort, workerData } from "node:worker_threads";
import { scanCellStorage, type CellStorageIdentity } from "./inodeScan.ts";
const request = workerData as {identity: CellStorageIdentity; maxEntries: number; timeoutMs: number};
try {
  parentPort?.postMessage({ok: true, result: scanCellStorage(request.identity, request.maxEntries, request.timeoutMs)});
} catch (error) {
  parentPort?.postMessage({ok: false, error: error instanceof Error ? error.message : "Cell storage validation failed"});
}
