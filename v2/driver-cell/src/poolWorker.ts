/**
 * Warm-pool and upstream refresh worker. Runs OFF the daemon event loop
 * (worker_threads) so the bounded upstream fetch and building a member — a
 * real `git clone --local` + checkout — never block RPC accept or the tick
 * loop (contract: Cell provisioning stays off the hot lane).
 *
 * One message = optionally refresh the origin's upstream mirror and move the
 * origin's default tracking ref to it, then build up
 * to `target` members at the origin's Cell base, one at a time, stopping early
 * on `maxSize` or any error (reported back, non-fatal to the daemon).
 */
import { parentPort, workerData } from "node:worker_threads";
import { buildPoolMember, poolMemberCount, reapPool, repoKeyFor, type TopUpRequest } from "./warmPool.ts";
import type { ProvisionOptions } from "./provision.ts";
import { resolveCellBase, syncOriginFromMirror, type OriginSync } from "./upstream.ts";

export type RefreshRequest = Omit<TopUpRequest, "sha"> & { sha?: string };

export interface PoolWorkerData {
  cellsRoot: string;
  request: RefreshRequest;
  target: number;
  maxSize: number;
  provisionOpts: ProvisionOptions;
  upstream?: { root: string; maxAgeMs: number; timeoutMs: number };
}

export interface PoolWorkerResult {
  ok: boolean;
  built: number;
  reaped: number;
  count: number;
  sha?: string;
  sync?: OriginSync;
  error?: string;
}

const data = workerData as PoolWorkerData;
const result: PoolWorkerResult = { ok: true, built: 0, reaped: 0, count: 0 };
try {
  if (data.upstream != null) {
    result.sync = syncOriginFromMirror(data.request.originRepo, data.upstream.root, data.upstream);
  }
  const sha = data.request.sha ?? resolveCellBase(data.request.originRepo)?.sha;
  if (sha != null) {
    result.sha = sha;
    if (data.target > 0) {
      const request: TopUpRequest = { ...data.request, sha };
      const repoKey = repoKeyFor(request.originRepo, request.repoName);
      result.reaped = reapPool(data.cellsRoot, repoKey, sha);
      let count = poolMemberCount(data.cellsRoot, repoKey);
      while (count < data.target && count < data.maxSize) {
        const built = buildPoolMember(data.cellsRoot, request, data.provisionOpts, { maxSize: data.maxSize });
        if (built == null) break;
        result.built++;
        count = poolMemberCount(data.cellsRoot, repoKey);
      }
      result.count = count;
    }
  }
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : String(error);
}
parentPort?.postMessage(result);
