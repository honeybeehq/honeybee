import { test } from "node:test";
import assert from "node:assert/strict";
import { passDiagnostics, readPassDiagnostics } from "../src/cellRetentionDiagnostics.ts";
import type { CellGcItem, CellGcOutcome } from "../src/protocol.ts";

function item(id: string, reason: CellGcItem["reason"]): CellGcItem {
  return { cellId: id, beeId: id, beeName: id, beeLifecycle: "archived", runtimeState: "stopped", cellState: "active", wrapperDir: "fixture", originRepo: null, head: null, bytes: null, idleSince: 0, verdict: "hold", reason, report: null, envFiles: [], trim: { entries: [], bytes: 0, planned: false }, keep: { entries: [], bytes: 0 } };
}
function outcome(id: string, status: CellGcOutcome["status"]): CellGcOutcome {
  return { cellId: id, beeId: id, wrapperDir: "fixture", status, reason: null, bytes: null, envFiles: [], keptPaths: [] };
}

test("diagnostics count inspection, apply and refusal results separately", () => {
  const d = passDiagnostics([item("origin", "dirty_origin_unknown"), item("inspect", "inspect_failed"), item("apply", "disk_pressure")], [outcome("apply", "failed"), outcome("origin", "refused")], []);
  assert.equal(d.errorCount, 2);
  assert.equal(d.inspectErrors, 1);
  assert.equal(d.applyErrors, 1);
  assert.equal(d.refused, 1);
  assert.equal(d.byReason.dirty_origin_unknown, 1);
  assert.equal(d.byCell.find(c => c.cellId === "apply")?.outcome, "failed");
  d.byCell[0]!.verdict = "keep";
  const restored = readPassDiagnostics(JSON.parse(JSON.stringify(d)))!;
  assert.deepEqual(restored, d);
  restored.byCell.length = 0;
  assert.equal(d.byCell.length, 3);
});

test("bounded details retain full counts and reject malformed cached diagnostics", () => {
  const d = passDiagnostics(Array.from({ length: 300 }, (_, n) => item(String(n), "inspect_failed")), [], []);
  assert.equal(d.cellCount, 300);
  assert.equal(d.errorCount, 300);
  assert.equal(d.byReason.inspect_failed, 300);
  assert.equal(d.byCell.length, 256);
  assert.equal(d.truncated, true);
  assert.equal(readPassDiagnostics({ ...d, byCell: [...d.byCell, d.byCell[0]] }), undefined);
  assert.equal(readPassDiagnostics({ ...d, errorCount: -1 }), undefined);
  assert.equal(readPassDiagnostics(undefined), undefined);
});
