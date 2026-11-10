import { Worker } from "node:worker_threads";
import { StoreBackupError, type StoreBackupVerification } from "../../core/src/storeBackup.ts";
import { transcriptSegmentWorkerUrl, type StoreBackupVerifyRequest, type StoreBackupVerifyResult } from "./transcriptSegmentWorker.ts";

export function verifyStoreBackupOffLoop(path: string, workerUrl: URL = transcriptSegmentWorkerUrl()): Promise<StoreBackupVerification> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { execArgv: [], workerData: { kind: "verifyStoreBackup", path } satisfies StoreBackupVerifyRequest });
    let settled = false;
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      run();
    };
    worker.once("message", (message: StoreBackupVerifyResult) => settle(() => {
      if (message.verified) resolve(message.verified);
      else reject(new StoreBackupError(message.error ?? "Backup verification failed"));
    }));
    worker.once("error", (error) => settle(() => reject(error)));
    worker.once("exit", (code) => settle(() => reject(new StoreBackupError(`Backup verification worker exited with code ${code} without a result`))));
  });
}
