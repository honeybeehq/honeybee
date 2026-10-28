/**
 * `hive archive` bulk shape: many refs, `-` (stdin is covered by the real-run
 * proof; here the refs come as arguments), --tree descendants, --dry-run,
 * working bees skipped unless --force, unknown refs reported without aborting,
 * already-archived bees unchanged, per-bee idempotency keys. Temp dirs only;
 * stub agent only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import { makeRegisteredServiceDir, registerService } from "../../daemon/tests/registered-service-fixture.ts";
import { runV2Cli, type CliIo } from "../src/main.ts";
import { stripAnsi } from "../src/style.ts";

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(stripAnsi(l)), err: (l) => err.push(stripAnsi(l)) }, out, err };
}

interface ArchiveJson {
  dryRun: boolean;
  bees: Array<{ ref: string; beeId: string | null; name: string | null; status: string; reason?: string; error?: string; commandId?: number | null; deduped?: boolean }>;
  summary: { total: number; archived: number; unchanged: number; skipped: number; failed: number };
}

async function spawnIdle(dir: string, name: string, parent?: string): Promise<string> {
  const s = capture();
  const argv = ["spawn", name, "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json", ...(parent ? ["--parent", parent] : [])];
  assert.equal(await runV2Cli(argv, s.io), 0, s.err.join("\n"));
  const beeId = (JSON.parse(s.out[0] ?? "{}") as { beeId: string }).beeId;
  await waitFor(async () => {
    const v = capture();
    await runV2Cli(["view", beeId, "--data-dir", dir, "--json"], v.io);
    return (JSON.parse(v.out[0] ?? "{}") as { view?: { runtimeState: string } }).view?.runtimeState === "idle";
  }, `${name} idle`, 20_000);
  return beeId;
}

async function lifecycleOf(dir: string, beeId: string): Promise<string | null> {
  const v = capture();
  await runV2Cli(["view", beeId, "--data-dir", dir, "--json"], v.io);
  return (JSON.parse(v.out[0] ?? "{}") as { view?: { lifecycle: string | null } }).view?.lifecycle ?? null;
}

async function archiveJson(dir: string, argv: string[]): Promise<{ code: number; json: ArchiveJson; err: string[] }> {
  const a = capture();
  const code = await runV2Cli(["archive", ...argv, "--data-dir", dir, "--json"], a.io);
  return { code, json: JSON.parse(a.out[0] ?? "{}") as ArchiveJson, err: a.err };
}

test("archive.bulk: --tree walks descendants once, --dry-run changes nothing, unknown refs fail without aborting, archived bees are unchanged", async () => {
  const { dir, cleanup } = makeRegisteredServiceDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const service = await daemon.client();
    await registerService(service, dir);
    service.close();
    const parent = await spawnIdle(dir, "bulk-parent");
    const childA = await spawnIdle(dir, "bulk-child-a", "bulk-parent");
    const childB = await spawnIdle(dir, "bulk-child-b", "bulk-parent");
    const grandchild = await spawnIdle(dir, "bulk-grandchild", "bulk-child-a");
    const loner = await spawnIdle(dir, "bulk-loner");

    const dry = await archiveJson(dir, ["bulk-parent", "bulk-child-a", "nope-not-a-bee", "--tree", "--dry-run"]);
    assert.equal(dry.code, 1, "an unknown ref makes the exit code non-zero");
    assert.equal(dry.json.dryRun, true);
    assert.equal(dry.json.bees[0]?.beeId, parent, "the named root comes first");
    assert.deepEqual(
      dry.json.bees.map((b) => [b.beeId ?? b.ref, b.status, b.error ?? null]).sort(),
      [
        [parent, "archived", null],
        [childA, "archived", null],
        [childB, "archived", null],
        [grandchild, "archived", null],
        ["nope-not-a-bee", "failed", "bee not found"],
      ].sort(),
      "every descendant listed once even though bulk-child-a is named and reachable through its parent",
    );
    assert.deepEqual(dry.json.summary, { total: 5, archived: 4, unchanged: 0, skipped: 0, failed: 1 });
    for (const id of [parent, childA, childB, grandchild, loner]) assert.equal(await lifecycleOf(dir, id), "active", "dry-run archives nothing");

    const real = await archiveJson(dir, ["bulk-parent", "--tree", "--idempotency-key", "sweep-1"]);
    assert.equal(real.code, 0);
    assert.equal(real.json.summary.archived, 4);
    assert.ok(real.json.bees.every((b) => b.status === "archived" && (b.commandId ?? 0) > 0));
    for (const id of [parent, childA, childB, grandchild]) {
      await waitFor(async () => (await lifecycleOf(dir, id)) === "archived", `${id} archived`, 10_000);
    }
    assert.equal(await lifecycleOf(dir, loner), "active", "a bee outside the tree is untouched");

    const replay = await archiveJson(dir, ["bulk-parent", "--tree", "--idempotency-key", "sweep-1"]);
    assert.equal(replay.code, 0);
    assert.equal(replay.json.summary.unchanged, 4, "already archived bees are unchanged, not errors");

    const mixed = capture();
    const code = await runV2Cli(["archive", "bulk-loner", "bulk-grandchild", "--data-dir", dir], mixed.io);
    assert.equal(code, 0);
    assert.ok(mixed.out.some((l) => l.includes("archived") && l.includes(loner)), mixed.out.join("\n"));
    assert.ok(mixed.out.some((l) => l.includes("unchanged") && l.includes(grandchild)), mixed.out.join("\n"));
    assert.match(mixed.out.at(-1) ?? "", /2 bees: 1 archived, 1 unchanged, 0 skipped, 0 failed/);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("archive.bulk: a working bee is skipped with reason working unless --force; the single-bee shape is unchanged", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const busy = await spawnIdle(dir, "bulk-busy");
    const quiet = await spawnIdle(dir, "bulk-quiet");
    assert.equal(await runV2Cli(["send", "bulk-busy", "@hang", "--data-dir", dir], capture().io), 0);
    await waitFor(async () => {
      const v = capture();
      await runV2Cli(["view", busy, "--data-dir", dir, "--json"], v.io);
      return (JSON.parse(v.out[0] ?? "{}") as { view?: { working: boolean } }).view?.working === true;
    }, "bulk-busy working", 10_000);

    const skipped = await archiveJson(dir, ["bulk-busy", "bulk-quiet"]);
    assert.equal(skipped.code, 0, "a skip is not a failure");
    assert.deepEqual(
      skipped.json.bees.map((b) => [b.beeId, b.status, b.reason ?? null]),
      [
        [busy, "skipped", "working"],
        [quiet, "archived", null],
      ],
    );
    await waitFor(async () => (await lifecycleOf(dir, quiet)) === "archived", "quiet archived", 10_000);
    assert.equal(await lifecycleOf(dir, busy), "active");

    const forced = await archiveJson(dir, ["bulk-busy", "bulk-quiet", "--force"]);
    assert.equal(forced.code, 0);
    assert.deepEqual(forced.json.bees.map((b) => b.status), ["archived", "unchanged"]);
    await waitFor(async () => (await lifecycleOf(dir, busy)) === "archived", "busy archived", 10_000);

    const single = await spawnIdle(dir, "bulk-single");
    const s = capture();
    assert.equal(await runV2Cli(["archive", "bulk-single", "--data-dir", dir, "--json"], s.io), 0);
    const r = JSON.parse(s.out[0] ?? "{}") as { beeId: string; commandId: number; bees?: unknown };
    assert.equal(r.beeId, single);
    assert.ok(r.commandId > 0);
    assert.equal(r.bees, undefined, "single-bee archive keeps its original payload");
    const h = capture();
    assert.equal(await runV2Cli(["archive", "bulk-single", "--data-dir", dir], h.io), 0);
    assert.match(h.out[0] ?? "", new RegExp(`archive ${single} enqueued \\(command \\d+\\)`));
    const missing = capture();
    assert.equal(await runV2Cli(["archive", "nope-not-a-bee", "--data-dir", dir], missing.io), 1);
    assert.ok(missing.err.some((l) => l.includes("bee not found")), missing.err.join("\n"));
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
