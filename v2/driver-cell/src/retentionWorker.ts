/**
 * Worker entrypoint for the retention pass: `inspectCellWrapper` over many
 * wrappers (git status + HEAD + a full du walk each) is seconds-to-minutes of
 * blocking work on a large cells root, so the daemon runs it here, off the
 * RPC lane, and applies the resulting plan on the main thread.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { LandingReceipt } from "./landed.ts";
import { inspectCellWrapper, planParkPaths, verifyParkPaths, type CellWrapperInspection, type ParkMode, type ParkPlan, type TrimSkip } from "./retention.ts";
import { refreshUpstreamMirror, type UpstreamRef } from "./upstream.ts";
import { confirmWip, pushWip, snapshotWip, sweepWipRefs, type WipSnapshot } from "./wip.ts";

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
  mode?: ParkMode;
}

export interface TrimVerifyWorkerResult {
  verified: Array<{ key: string; confirmed: string[]; skipped: TrimSkip[]; shallow: string[]; error: string | null }>;
}

export interface ParkPlanWorkerRequest {
  kind: "planPark";
  wrapperDir: string;
  mode: ParkMode;
  trimPatterns: string[];
}

export interface ParkPlanWorkerResult {
  plan: ParkPlan | null;
  error: string | null;
}

export interface WipPushWorkerRequest {
  kind: "pushWip";
  spaceDir: string;
  boxDir: string;
  originRepo: string;
  node: string;
  cellId: string;
  maxFileBytes: number;
  previous: { sha: string; tree: string } | null;
}

export interface WipPushWorkerResult {
  snapshot: WipSnapshot | null;
  confirmed: boolean;
  unchanged: boolean;
  error: string | null;
}

export interface WipRefSweepWorkerRequest {
  kind: "sweepWipRefs";
  node: string;
  origins: Array<{ originRepo: string; liveCellIds: string[] }>;
}

export interface WipRefSweepWorkerResult {
  swept: Array<{ originRepo: string; dropped: string[]; migrated: string[] }>;
  error: string | null;
}

const request = workerData as RetentionWorkerRequest | TrimVerifyWorkerRequest | ParkPlanWorkerRequest | WipPushWorkerRequest | WipRefSweepWorkerRequest;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
if (request.kind === "pushWip") {
  try {
    const snapshot = snapshotWip(request.spaceDir, request.boxDir, request.cellId, Date.now, request.maxFileBytes);
    if (request.previous && snapshot.tree === request.previous.tree && confirmWip(request.originRepo, request.node, request.cellId, request.previous.sha)) {
      parentPort?.postMessage({ snapshot: { ...snapshot, sha: request.previous.sha }, confirmed: true, unchanged: true, error: null } satisfies WipPushWorkerResult);
    } else {
      pushWip(request.originRepo, request.spaceDir, request.node, request.cellId, snapshot.sha);
      parentPort?.postMessage({ snapshot, confirmed: confirmWip(request.originRepo, request.node, request.cellId, snapshot.sha), unchanged: false, error: null } satisfies WipPushWorkerResult);
    }
  } catch (err) {
    parentPort?.postMessage({ snapshot: null, confirmed: false, unchanged: false, error: errorText(err) } satisfies WipPushWorkerResult);
  }
} else if (request.kind === "sweepWipRefs") {
  try {
    const swept = request.origins.map((origin) => ({ originRepo: origin.originRepo, ...sweepWipRefs(origin.originRepo, request.node, new Set(origin.liveCellIds)) })).filter((o) => o.dropped.length > 0 || o.migrated.length > 0);
    parentPort?.postMessage({ swept, error: null } satisfies WipRefSweepWorkerResult);
  } catch (err) {
    parentPort?.postMessage({ swept: [], error: errorText(err) } satisfies WipRefSweepWorkerResult);
  }
} else if (request.kind === "planPark") {
  try {
    parentPort?.postMessage({ plan: planParkPaths(request.wrapperDir, request.mode, { trimPatterns: request.trimPatterns, measure: true }), error: null } satisfies ParkPlanWorkerResult);
  } catch (err) {
    parentPort?.postMessage({ plan: null, error: errorText(err) } satisfies ParkPlanWorkerResult);
  }
} else if (request.kind === "verifyTrim") {
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
