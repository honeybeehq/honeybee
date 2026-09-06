import { parentPort, workerData } from "node:worker_threads";
import { gitImagesRootForCells, refreshGitImage } from "./gitImage.ts";
import { cellPaths } from "./layout.ts";
import { readLedger } from "./ledger.ts";
import { provisionCell, type ProvisionRequest } from "./provision.ts";

interface ProvisionWorkerData {
  cellsRoot: string;
  request: ProvisionRequest;
  opId: string;
  disableCow: boolean;
  useGitImages: boolean;
  gitImagesRoot?: string;
}

interface ProvisionWorkerResult {
  ok: boolean;
  error?: string;
}

interface MaintenanceStart {
  kind: "refresh_git_image";
}

const MAINTENANCE_FALLBACK_MS = 30_000;

async function waitForMaintenanceStart(): Promise<void> {
  const port = parentPort;
  if (port == null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.off("message", onMessage);
      resolve();
    };
    const onMessage = (message: MaintenanceStart): void => {
      if (message?.kind === "refresh_git_image") done();
    };
    const timer = setTimeout(done, MAINTENANCE_FALLBACK_MS);
    port.on("message", onMessage);
  });
}

const data = workerData as ProvisionWorkerData;
let provisionedFreshImage = false;

try {
  const request = data.request;
  const paths = cellPaths(data.cellsRoot, request.wrapper, request.repoName, request.cellId);
  const ledger = readLedger(paths.ledgerPath);
  // `replayed` stays false when an incomplete operation resumes. Remember the
  // pre-call state so only a genuinely first provisioning can skip its retry.
  const hadProvisionAttempt = ledger != null && Object.keys(ledger.operations).length > 0;
  const cell = provisionCell(data.cellsRoot, request, data.opId, {
    disableCow: data.disableCow,
    useGitImages: data.useGitImages,
    gitImagesRoot: data.gitImagesRoot,
  });
  provisionedFreshImage = !hadProvisionAttempt && !cell.replayed && cell.copyMode === "image-cow";
  parentPort?.postMessage({ ok: true } satisfies ProvisionWorkerResult);
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  } satisfies ProvisionWorkerResult);
  process.exitCode = 1;
}

// Fresh image placement already validated the requested graph. Replays and
// fallback placements keep the deferred retry because the image may be gone
// or stale. A cache failure never turns a provisioned Cell into a failed start.
if (process.exitCode == null && data.useGitImages && !data.disableCow && !provisionedFreshImage) {
  await waitForMaintenanceStart();
  try {
    refreshGitImage(
      data.gitImagesRoot ?? gitImagesRootForCells(data.cellsRoot),
      data.request.originRepo,
      data.request.sha,
    );
  } catch {
    // A later Cell retries under the per-repository stale-safe build lock.
  }
}
