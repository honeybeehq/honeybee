/**
 * `hive config get|set cells.retention.*` writes the retention section of a
 * node's config.json through the daemon's own parser (atomic, 0600, every
 * other key kept, a value the parser would fall back from refused), and the
 * daemon reads it at boot: two real daemons, one whose config was set to
 * plan before its boot and one whose config has no such key, report the
 * mode their scheduled passes run with. Temp dirs and stub agents only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runV2Cli, type CliIo } from "../../cli/src/main.ts";
import type { CellGcResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

async function cli(args: string[], dataDir: string): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const io: CliIo = { out: (l) => lines.push(l), err: (l) => lines.push(l) };
  const code = await runV2Cli([...args, "--data-dir", dataDir], io);
  return { code, text: lines.join("\n") };
}

test("retention-config: set writes only the retention key, keeps the rest (a secret included) at 0600, refuses an invalid value, and get --effective resolves the default", async () => {
  const { dir, cleanup } = makeDaemonDir({ naming: { apiKey: "sk-secret-never-printed" } });
  try {
    const configPath = join(dir, "config.json");
    const before = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const unset = await cli(["config", "get", "cells.retention.mode", "--effective"], dir);
    assert.equal(unset.code, 0);
    assert.match(unset.text, /cells\.retention\.mode = "apply" \(effective, nodeKind workstation\)/, "the default is apply when the key is absent");
    assert.doesNotMatch(unset.text, /sk-secret/);

    const set = await cli(["config", "set", "cells.retention.mode", "plan"], dir);
    assert.equal(set.code, 0, set.text);
    assert.match(set.text, /cells\.retention\.mode = "plan"/);
    assert.doesNotMatch(set.text, /sk-secret/);
    const after = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal((after.cells as { retention: { mode: string } }).retention.mode, "plan");
    assert.deepEqual({ ...after, cells: undefined }, { ...before, cells: undefined }, "every other key is preserved");
    assert.equal((after.naming as { apiKey: string }).apiKey, "sk-secret-never-printed");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);

    const bad = await cli(["config", "set", "cells.retention.mode", "dry"], dir);
    assert.notEqual(bad.code, 0);
    assert.match(bad.text, /cells\.retention\.mode must be "apply" or "plan"/);
    assert.equal((JSON.parse(readFileSync(configPath, "utf8")) as { cells: { retention: { mode: string } } }).cells.retention.mode, "plan", "a refused value writes nothing");
    const unknown = await cli(["config", "set", "cells.retention.evictEverything", "true"], dir);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.text, /is not a retention key/);

    const got = await cli(["config", "get", "cells.retention"], dir);
    assert.match(got.text, /"mode": "plan"/);
    assert.doesNotMatch(got.text, /sk-secret|naming/);
    const enforce = await cli(["config", "set", "cells.retention.budgetEnforce", "false"], dir);
    assert.equal(enforce.code, 0);
    assert.match((await cli(["config", "get", "cells.retention.budgetEnforce", "--effective"], dir)).text, /= false \(effective/);
    const cleared = await cli(["config", "set", "cells.retention.budgetEnforce", "unset"], dir);
    assert.equal(cleared.code, 0);
    assert.equal((JSON.parse(readFileSync(configPath, "utf8")) as { cells: { retention: Record<string, unknown> } }).cells.retention.budgetEnforce, undefined);
    writeFileSync(join(dir, "config.json"), "{not json");
    const broken = await cli(["config", "get", "cells.retention.mode", "--effective"], dir);
    assert.notEqual(broken.code, 0);
    assert.match(broken.text, /not valid json/);
  } finally {
    cleanup();
  }
});

test("retention-config: two daemons — one set to plan before boot runs plan-only scheduled passes, one with no key runs apply", { timeout: 180_000 }, async () => {
  const planned = makeDaemonDir({ cells: { retention: { enabled: true } } });
  const plain = makeDaemonDir({ cells: { retention: { enabled: true } } });
  let a: DaemonHandle | null = null;
  let b: DaemonHandle | null = null;
  try {
    const set = await cli(["config", "set", "cells.retention.mode", "plan"], planned.dir);
    assert.equal(set.code, 0, set.text);
    a = await startDaemon(planned.dir);
    b = await startDaemon(plain.dir);
    const planPolicy = (await (await a.client()).request<CellGcResult>("cell.gc", {}, 60_000)).policy;
    const plainPolicy = (await (await b.client()).request<CellGcResult>("cell.gc", {}, 60_000)).policy;
    assert.equal(planPolicy.mode, "plan", "the daemon booted with the key written before its boot");
    assert.equal(plainPolicy.mode, "apply", "no key: the product default");
    assert.equal(planPolicy.enabled, true);
    assert.equal(plainPolicy.enabled, true);
  } finally {
    await a?.stop();
    await b?.stop();
    planned.cleanup();
    plain.cleanup();
  }
});
