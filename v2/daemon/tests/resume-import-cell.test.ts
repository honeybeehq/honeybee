/**
 * H6c Cell import: executor A runs a Cell bee whose WIP is pushed to the
 * origin (H3); A is killed; executor B imports the bee with the Cell
 * descriptor carrying the WIP sha and tree, adopts the ref under its own node
 * scope, re-provisions the Cell from the origin and lays the WIP back before
 * the first runtime. Stub agents, a fixture origin and temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import type { BeeImportResult, SendRpcResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

function makeRig(root: string, name: string, durability: Record<string, unknown>) {
  const cellsRoot = join(root, `cells-${name}`);
  mkdirSync(cellsRoot, { recursive: true });
  const { dir, cleanup } = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    durability: { resumeBundle: { enabled: true, keyFile: join(root, "ws.key") }, ...durability },
    transcripts: { segments: { storeDir: join(root, "objects") } },
    cells: { root: cellsRoot, retention: { enabled: true, wipPushOnTurnEnd: true, wipMinIntervalSeconds: 0 } },
    agents: {
      cellstub: {
        command: process.execPath, args: [CELL_AGENT_PATH], adapter: "stub",
        env: { GIT_AUTHOR_NAME: "cell-bee", GIT_AUTHOR_EMAIL: "bee@hive.invalid", GIT_COMMITTER_NAME: "cell-bee", GIT_COMMITTER_EMAIL: "bee@hive.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      },
    },
  });
  return { dir, cleanup };
}

async function shInCell(client: RpcClient, beeId: string, cmd: string): Promise<void> {
  const before = (await client.request<ViewResult>("view", { beeId })).view;
  const sent = await client.request<SendRpcResult>("send", { beeId, body: `@sh ${cmd}` });
  await waitFor(async () => {
    const v = (await client.request<ViewResult>("view", { beeId })).view;
    return v.runtimeState === "idle" && (v.lastOutputAt ?? 0) > (before.lastOutputAt ?? 0);
  }, `turn ended: ${cmd} (message ${sent.messageId})`, 30_000);
}

test("resume-import-cell.1: a Cell bee's WIP follows it to the importing executor", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-import-cell-"));
  mkdirSync(join(root, "objects"), { recursive: true });
  const origin = makeOrigin(root);
  writeFileSync(join(origin.repo, ".gitignore"), ".next/\n");
  g(origin.repo, ["add", ".gitignore"]);
  g(origin.repo, ["commit", "-q", "-m", "ignores"]);
  const rigA = makeRig(root, "a", {});
  const rigB = makeRig(root, "b", { import: { enabled: true } });
  let a: DaemonHandle | null = null;
  let b: DaemonHandle | null = null;
  try {
    a = await startDaemon(rigA.dir);
    const clientA = await a.client();
    const spawned = await clientA.request<SpawnResult>("spawn", { name: "cellular", agent: "cellstub", substrate: "cell", cell: { originRepo: origin.repo } });
    const beeId = spawned.beeId;
    const viewA = await waitFor(async () => {
      const v = await clientA.request<ViewResult>("view", { beeId });
      return v.view.runtimeState === "idle" && v.cell ? v : null;
    }, "cell bee idle", 60_000);
    await shInCell(clientA, beeId, "printf 'draft from A\\n' > notes.md && mkdir -p .next && printf 'x\\n' > .next/out.js");
    const withWip = await waitFor(async () => {
      const v = await clientA.request<ViewResult>("view", { beeId });
      return v.cell?.wipConfirmedAt != null ? v : null;
    }, "WIP pushed from A", 30_000);
    const cellA = withWip.cell!;
    await a.kill();
    a = null;

    b = await startDaemon(rigB.dir);
    const clientB = await b.client();
    const imported = await clientB.request<BeeImportResult>("bee.import", {
      descriptor: { id: beeId, name: viewA.bee!.name, agent: "cellstub", handle: viewA.bee!.handle!, cell: { originRepo: origin.repo, sha: cellA.sha, wipSha: cellA.wipSha!, wipTree: cellA.wipTree! } },
      resume: null,
      fence: { epoch: 0, fencedAt: Date.now() },
      idempotencyKey: "cell-import-1",
    });
    assert.equal(imported.wipRestore, "adopted", "the WIP ref is adopted under this node's scope");
    assert.equal(imported.unfenced, false);
    assert.equal(imported.resumed, "fresh");
    const viewB = await waitFor(async () => {
      const v = await clientB.request<ViewResult>("view", { beeId });
      return v.view.runtimeState === "idle" && v.cell ? v : null;
    }, "imported cell bee idle", 120_000);
    assert.notEqual(viewB.cell!.spaceDir, cellA.spaceDir, "B provisions its own Cell");
    assert.equal(g(viewB.cell!.spaceDir, ["rev-parse", "HEAD"]), cellA.sha, "at the Cell's commit");
    assert.equal(readFileSync(join(viewB.cell!.spaceDir, "notes.md"), "utf8"), "draft from A\n", "the WIP is back in the new checkout");
    assert.equal(existsSync(join(viewB.cell!.spaceDir, ".next")), false, "ignored output did not travel");
    assert.equal(viewB.cell!.wipSha, cellA.wipSha);
    assert.match(readFileSync(join(rigB.dir, "hived.log"), "utf8"), /cell\.wip\.restored bee=/);
  } finally {
    await a?.stop();
    await b?.stop();
    rigA.cleanup();
    rigB.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
