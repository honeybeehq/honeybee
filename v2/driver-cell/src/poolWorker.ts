/**
 * Warm-pool top-up worker. Runs OFF the daemon event loop (worker_threads) so
 * building a member — a real `git clone --local` + checkout — never blocks RPC
 * accept or the tick loop (contract: Cell provisioning stays off the hot lane).
 *
 * One message = build up to `target` members at `sha`, one at a time, stopping
 * early on `maxSize` or any error (reported back, non-fatal to the daemon).
 */
import { parentPort, workerData } from "node:worker_threads";
import { buildPoolMember, poolMemberCount, reapPool, repoKeyFor, type TopUpRequest } from "./warmPool.ts";
import type { ProvisionOptions } from "./provision.ts";

interface PoolWorkerData {
  cellsRoot: string;
  request: TopUpRequest;
  target: number;
  maxSize: number;
  provisionOpts: ProvisionOptions;
}

interface PoolWorkerResult {
  ok: boolean;
  built: number;
  reaped: number;
  count: number;
  error?: string;
}

const data = workerData as PoolWorkerData;
const result: PoolWorkerResult = { ok: true, built: 0, reaped: 0, count: 0 };
try {
  const repoKey = repoKeyFor(data.request.originRepo, data.request.repoName);
  // Drop stale/dirty members first so the pool tracks the current sha.
  result.reaped = reapPool(data.cellsRoot, repoKey, data.request.sha);
  let count = poolMemberCount(data.cellsRoot, repoKey);
  while (count < data.target && count < data.maxSize) {
    const built = buildPoolMember(data.cellsRoot, data.request, data.provisionOpts, { maxSize: data.maxSize });
    if (built == null) break;
    result.built++;
    count = poolMemberCount(data.cellsRoot, repoKey);
  }
  result.count = count;
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : String(error);
}
parentPort?.postMessage(result);
