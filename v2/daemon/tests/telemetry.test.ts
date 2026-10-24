/** Spec 04 behavior 5: the i1_violations table — durable, deduped, ledger-shaped. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryStore, formatI1Violation } from "../src/telemetry.ts";
import type { I1ViolationEvent } from "../src/loops.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";

const V: I1ViolationEvent = {
  detectedAt: 5000,
  beeId: "bee-1",
  messageId: 7,
  enqueuedAt: 1000,
  deadline: 4000,
  detail: "message 7 undelivered past deadline",
};

test("telemetry.1: violation rows persist, dedup by message id across reopen, and count", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-tel-"));
  const path = join(dir, "telemetry.sqlite3");
  try {
    const t1 = new TelemetryStore(path);
    assert.equal(t1.i1Count(), 0);
    assert.equal(t1.recordI1(V, ["op1", "op2"]), true);
    assert.equal(t1.recordI1(V), false, "same message: recorded once");
    assert.equal(t1.recordI1({ ...V, messageId: 8 }), true);
    assert.equal(t1.i1Count(), 2);
    t1.close();
    // A daemon restart re-detecting the same breach must not double-count.
    const t2 = new TelemetryStore(path);
    assert.equal(t2.recordI1(V), false);
    assert.equal(t2.i1Count(), 2);
    const rows = t2.listI1();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.messageId, 7);
    assert.equal(rows[0]?.invariant, "I1");
    assert.deepEqual(rows[0]?.ops, ["op1", "op2"]);
    t2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry.2: the log line matches the harness ledger shape", () => {
  const line = JSON.parse(formatI1Violation(V, ["a"])) as Record<string, unknown>;
  assert.deepEqual(Object.keys(line).sort(), ["bee", "detail", "invariant", "ops", "step"]);
  assert.equal(line.invariant, "I1");
  assert.equal(line.bee, "bee-1");
});

test("telemetry.3: repeated daemon violations retain useful history without nesting earlier violation payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-tel-history-"));
  const cfg = loadNodeConfig(dir);
  const telemetry = new TelemetryStore(cfg.telemetryPath);
  const daemon = new HiveDaemon(cfg) as unknown as {
    telemetry: TelemetryStore;
    log(op: string): void;
    recordI1(event: I1ViolationEvent): void;
  };
  daemon.telemetry = telemetry;
  try {
    daemon.log("deliver.refused bee=bee-1 reason=not_ready");
    for (let messageId = 1; messageId <= 256; messageId++) {
      daemon.recordI1({ ...V, messageId });
      const rows = telemetry.listI1();
      assert.equal(rows.length, messageId);
      const row = rows.at(-1)!;
      assert.ok(row.ops.length <= 40);
      assert.ok(JSON.stringify(row.ops).length < 16_384, "recent operations must not expand recursively");
      assert.ok(row.ops.every(op => !op.startsWith("i1_violation {")));
    }
    const lines = readFileSync(cfg.logPath, "utf8").trim().split("\n");
    const violations = lines.map(line => JSON.parse(line).op as string).filter(op => op.startsWith("i1_violation {"));
    assert.equal(violations.length, 256);
    const first = JSON.parse(violations[0]!.slice("i1_violation ".length));
    assert.equal(first.detail, V.detail);
    assert.deepEqual(first.ops, ["deliver.refused bee=bee-1 reason=not_ready"]);
    assert.ok(violations.every(line => line.length < 16_384));
    assert.ok(telemetry.listI1().at(-1)!.ops.some(op => op.includes("msg=255")));
    daemon.recordI1({ ...V, messageId: 256 });
    assert.equal(telemetry.i1Count(), 256);
    assert.equal(readFileSync(cfg.logPath, "utf8").trim().split("\n").length, lines.length);
    telemetry.close();
    const reopened = new TelemetryStore(cfg.telemetryPath);
    daemon.telemetry = reopened;
    try {
      daemon.recordI1({ ...V, messageId: 256 });
      assert.equal(reopened.i1Count(), 256);
      assert.equal(readFileSync(cfg.logPath, "utf8").trim().split("\n").length, lines.length);
    } finally {
      reopened.close();
    }
  } finally {
    telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
