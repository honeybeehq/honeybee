import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runV2Cli, type CliIo } from "../src/main.ts";

test("offline build-pin CLI refuses every policy write and retains read-only stale reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-pin-cli-")), dataDir = join(root, "v2");
  mkdirSync(dataDir);
  const out: string[] = [], err: string[] = [];
  const io: CliIo = { out: line => out.push(line), err: line => err.push(line) };
  const base = ["--offline", "--data-dir", dataDir, "--json"];
  const pin = { schemaVersion: 1, sourceRevision: "a".repeat(40), target: `${process.platform}-${process.arch}` };
  assert.equal(await runV2Cli(["build-pin", "set", pin.sourceRevision, pin.target, ...base], io), 1);
  assert.match(err.at(-1)!, /offline writes are refused/);
  assert.equal(await runV2Cli(["build-pin", "show", ...base], io), 0, err.join("\n"));
  assert.equal(JSON.parse(out.at(-1)!).desired, null);
  assert.equal(await runV2Cli(["build-report", ...base], io), 0, err.join("\n"));
  const report = JSON.parse(out.at(-1)!);
  assert.equal(report.stale, true);
  assert.equal(report.running, null);
  assert.equal(report.schemaVersion, null);
  assert.equal(report.verdict, "unknown");
  assert.equal(await runV2Cli(["build-pin", "clear", ...base], io), 1);
  assert.match(err.at(-1)!, /offline writes are refused/);
  assert.equal(existsSync(join(root, "runtime", "build-pin.json")), false);
  assert.equal(existsSync(join(root, "runtime", "build-pin-changes.jsonl")), false);
});
