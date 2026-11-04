import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { HiveDaemon } from "../src/daemon.ts";
import { resolveCellSandboxPolicy, sandboxEnabled } from "../../driver-cell/src/sandbox.ts";
import type { CellSpec } from "../../driver-cell/src/driver.ts";

test("harness and retained/secret exec agree for every kind, daemon policy and Cell override", () => {
  const root = mkdtempSync("/tmp/hb-cell-policy-");
  let cases = 0;
  try {
    const prototype = HiveDaemon.prototype as unknown as {resolveCellSpec(beeId: string): CellSpec};
    for (const kind of [undefined, "workstation", "satellite"] as const) {
      for (const configured of [null, false, true]) {
        for (const override of [null, false, true]) {
          const cfg = {nodeKind: kind ?? "workstation", nodeKindExplicit: kind !== undefined, cellSandbox: configured, cellRetention: {wipPushOnTurnEnd: false}};
          const cell = {id: "cell", state: "active", sandbox: override, spaceDir: root, spaceName: "repo-space-cell", originRepo: root, sha: "0".repeat(40), wrapper: "fixture"};
          const context = {cfg, mustStore: () => ({getBee: () => ({cellId: "cell"}), getCell: () => cell})};
          const harness = prototype.resolveCellSpec.call(context, "bee");
          const exec = resolveCellSandboxPolicy(cfg.nodeKind, cell.sandbox, cfg.cellSandbox);
          const expected = override !== null ? override : configured !== null ? configured : kind === "satellite";
          const label = JSON.stringify({kind: kind ?? "unset", configured, override});
          assert.equal(sandboxEnabled(cfg.nodeKind, harness.sandbox), expected, `harness ${label}`);
          assert.equal(exec.enabled, expected, `retained/secret exec ${label}`);
          assert.equal(harness.sandbox, exec.override, `same explicitness ${label}`);
          if (override === null && configured === null) assert.equal(exec.override, null, `implicit policy preserved ${label}`);
          cases++;
        }
      }
    }
    assert.equal(cases, 27);
    console.log(JSON.stringify({fixture: "effective Cell sandbox policy", cases, harnessEqualsExec: true, includesSecretExec: true}));
  } finally {rmSync(root, {recursive: true, force: true});}
});
