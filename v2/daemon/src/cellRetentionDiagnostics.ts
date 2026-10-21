import { CELL_GC_REASONS, CELL_GC_VERDICTS } from "./protocol.ts";
import type { CellGcItem, CellGcOutcome, CellGcPassDiagnostics, CellGcTrimOutcome } from "./protocol.ts";

export function passDiagnostics(items: readonly CellGcItem[], outcomes: readonly CellGcOutcome[], trims: readonly CellGcTrimOutcome[], inspectionErrors?: number): CellGcPassDiagnostics {
  const inspectErrors = inspectionErrors ?? items.filter(i => i.reason === "inspect_failed").length;
  const applied = [...outcomes, ...trims];
  const applyErrors = applied.filter(o => o.status === "failed").length;
  const byReason: CellGcPassDiagnostics["byReason"] = {};
  for (const item of items) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
  const latest = new Map(applied.map(o => [o.cellId ?? `bee:${o.beeId}`, o.status]));
  return {
    errorCount: inspectErrors + applyErrors, inspectErrors, applyErrors,
    refused: applied.filter(o => o.status === "refused").length,
    cellCount: items.length, truncated: items.length > 256, byReason,
    byCell: items.slice(0, 256).map(i => ({
      cellId: i.cellId, beeId: i.beeId, reason: i.reason, verdict: i.verdict,
      outcome: latest.get(i.cellId ?? `bee:${i.beeId}`) ?? null,
    })),
  };
}

export function readPassDiagnostics(value: unknown): CellGcPassDiagnostics | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const d = value as Record<string, unknown>;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (![d.errorCount, d.inspectErrors, d.applyErrors, d.refused, d.cellCount].every(count)
    || typeof d.truncated !== "boolean" || !Array.isArray(d.byCell) || d.byCell.length > 256
    || !d.byReason || typeof d.byReason !== "object" || Array.isArray(d.byReason)) return undefined;
  const reasons = new Set<string>(CELL_GC_REASONS);
  const verdicts = new Set<string>(CELL_GC_VERDICTS);
  if (!Object.entries(d.byReason).every(([key, n]) => reasons.has(key) && count(n))) return undefined;
  for (const entry of d.byCell) {
    if (!entry || typeof entry !== "object" || !(entry.cellId === null || typeof entry.cellId === "string")
      || typeof entry.beeId !== "string" || !reasons.has(entry.reason)
      || !verdicts.has(entry.verdict)
      || !(entry.outcome === null || ["evicted", "removed", "refused", "absent", "failed", "trimmed"].includes(entry.outcome))) return undefined;
  }
  return structuredClone(value) as CellGcPassDiagnostics;
}
