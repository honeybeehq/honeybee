import { parentPort, workerData } from "node:worker_threads";
import { executeCellRepoBatch } from "./cellRepoExecutor.ts";
import { CellRepoRefusal } from "./cellRepoProtocol.ts";

const abort = new AbortController();
parentPort?.on("message", () => abort.abort());
void executeCellRepoBatch(workerData, abort.signal).then(
  result => parentPort?.postMessage({ result }),
  error => parentPort?.postMessage({ failure: error instanceof CellRepoRefusal ? error.code : "invalid_repository" }),
).finally(() => parentPort?.close());
