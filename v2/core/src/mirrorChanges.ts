import type { AuditRow, BeeEpochRow, BeeResumeBundleRow, TranscriptSegmentObjectRow } from "./types.ts";

export const MIRROR_CHANGES_DEFAULT_LIMIT = 1000;
export const MIRROR_CHANGES_MAX_LIMIT = 1000;

export type MirrorCursor = { epoch: string; seq: number };
export type MirrorCoverage = {
  scope: "mirror.v1" | "mirror.local.homes.v1";
  fromSeq: number;
  throughSeq: number;
  headSeq: number;
  retainedAfterSeq: number;
  complete: true;
};
export type MirrorChangesResult =
  | { status: "ok"; cursor: MirrorCursor; coverage: MirrorCoverage; events: AuditRow[]; hasMore: boolean }
  | { status: "resync_required"; reason: "unknown_cursor" | "epoch_changed" | "too_old" | "cursor_ahead"; cursor: MirrorCursor };
export type MirrorReceiptBaseline = {
  resumeBundles: BeeResumeBundleRow[];
  segmentObjects: TranscriptSegmentObjectRow[];
  beeEpochs: BeeEpochRow[];
  complete: true;
  truncated: false;
};
