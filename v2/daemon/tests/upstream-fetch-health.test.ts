import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/store.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";
import { CellRetentionService } from "../src/cellRetention.ts";
import type { HealthResult, DeployInfoResult } from "../src/protocol.ts";

test("health and deployment information expose background upstream holds without reading mirrors", async () => {
  const root = mkdtempSync(join(tmpdir(), "upstream-health-"));
  const store = openCoreStore(join(root, "fixture.sqlite3"));
  const cfg = loadNodeConfig(root);
  mkdirSync(cfg.cellsRoot);
  cfg.cellRetention.fetchUpstream = true;
  const retention = new CellRetentionService({ cellsRoot: cfg.cellsRoot, policy: cfg.cellRetention, store: () => store, now: Date.now, log: () => {}, cellInUse: () => false, opInFlight: () => false, forgetCell: () => {} });
  const daemon = new HiveDaemon(cfg);
  Reflect.set(daemon, "store", store);
  Reflect.set(daemon, "retention", retention);
  const health = () => Reflect.get(daemon, "rpcHealth").call(daemon) as HealthResult;
  const info = () => Reflect.get(daemon, "rpcDeployInfo").call(daemon) as DeployInfoResult;
  try {
    assert.equal(health().upstreamFetch?.checked, false);
    retention.noteUpstreamRefresh("/fixture/origin", { status: "failed", code: "invalid_objects", parked: true, error: "object validation refused" });
    assert.equal(health().upstreamFetch?.failures[0]?.code, "invalid_objects");
    assert.equal(info().upstreamFetch?.failures[0]?.parked, true);
    retention.noteUpstreamRefresh("/fixture/origin", { status: "fresh" });
    assert.equal(health().upstreamFetch?.failures.length, 0);
  } finally { await retention.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
