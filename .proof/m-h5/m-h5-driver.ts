// M-H5 scratch-daemon driver (proof evidence, not a test). Run from the repo root with every HIVE_* variable unset:
//   HB_M_H5_LOG=.proof/m-h5/recorded-run.md node scripts/with-fixture-warden.mjs node --experimental-strip-types .proof/m-h5/m-h5-driver.ts
// Two daemons stand in for two executors: each has its own data dir, socket, HOME, champion homes dir and object store.
// Nothing is shared between them but the bytes champion.export hands out. Nothing touches ~/.hive.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../v2/cli/src/client.ts";
import { runV2Cli } from "../../v2/cli/src/main.ts";
import { RpcError, type ChampionExportResult, type ChampionFenceResult, type ChampionGetResult, type ChampionListResult, type ChampionPutResult, type ChampionStartResult, type DeployInfoResult, type SendRpcResult, type SnapshotResult, type TemplatePutResult, type ViewResult } from "../../v2/daemon/src/protocol.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, waitFor, type DaemonHandle } from "../../v2/daemon/tests/helpers.ts";

for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "KIMI_CODE_HOME", "OPENCODE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "HIVE_V2_DATA_DIR", "HIVE_V2_SOCKET_PATH"]) delete process.env[key];
const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "v2", "driver-cell", "test-agent", "agent.mjs");
const log = process.env.HB_M_H5_LOG;
const note = (line: string) => { console.log(line); if (log) appendFileSync(log, `${line}\n`); };
const show = (label: string, value: unknown) => note(`\n## ${label}\n\`\`\`json\n${JSON.stringify(value, (k, v) => (k === "homeBytes" && typeof v === "string" ? `<base64, ${v.length} chars>` : v), 2)}\n\`\`\``);
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return e instanceof RpcError ? `${e.code}${e.details?.reason ? ` (${String(e.details.reason)})` : ""}: ${e.message}` : String(e); } };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const tree = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const visit = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, entry.name); if (entry.isDirectory()) visit(p); else if (entry.isFile()) out[relative(root, p)] = sha(readFileSync(p)).slice(0, 16); } };
  visit(root);
  return out;
};
const ms = async <T>(f: () => Promise<T>): Promise<{ result: T; ms: number }> => { const t = performance.now(); const result = await f(); return { result, ms: Math.round((performance.now() - t) * 10) / 10 }; };

function rig(root: string, name: string) {
  const objects = join(root, `objects-${name}`);
  mkdirSync(objects, { recursive: true });
  const made = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    champions: { homesDir: join(root, `homes-${name}`) },
    transcripts: { segments: { storeDir: objects } },
    agents: { cellstub: { command: process.execPath, args: [CELL_AGENT_PATH], adapter: "stub" } },
  } as Parameters<typeof makeDaemonDir>[0]);
  return { ...made, objects, homes: join(root, `homes-${name}`) };
}

async function shIn(client: RpcClient, beeId: string, cmd: string): Promise<void> {
  const before = (await client.request<ViewResult>("view", { beeId })).view;
  const sent = await client.request<SendRpcResult>("send", { beeId, body: `@sh ${cmd}` });
  await waitFor(async () => {
    const v = (await client.request<ViewResult>("view", { beeId })).view;
    return v.runtimeState === "idle" && (v.lastOutputAt ?? 0) > (before.lastOutputAt ?? 0);
  }, `turn ended: ${cmd} (message ${sent.messageId})`, 30_000);
}
const idle = (client: RpcClient, beeId: string) => waitFor(async () => { const v = await client.request<ViewResult>("view", { beeId }); return v.view.runtimeState === "idle" ? v : null; }, "idle", 60_000);
const stopped = (client: RpcClient, beeId: string) => waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped" ? true : null, "stopped", 30_000);

if (log) writeFileSync(log, `# M-H5 recorded run ${new Date().toISOString()}\ntwo scratch daemons (executors A and B) under the fixture base, each with its own data dir, socket, HOME, champion homes dir and object store\n`);
const dirs: Array<{ cleanup: () => void }> = [], handles: DaemonHandle[] = [], clients: RpcClient[] = [];
const cleanup = async () => { clients.forEach((c) => c.close()); await Promise.allSettled(handles.map(forceStopTestDaemon)); dirs.forEach((d) => d.cleanup()); };
const root = join(dirname(makeDaemonDir().dir), `m-h5-${process.pid}`);
mkdirSync(root, { recursive: true });

try {
  note("\n# A. executor A: the Champion is created, runs in its home, writes memory, and its home is bundled at turn end");
  const ra = rig(root, "a"), rb = rig(root, "b"); dirs.push(ra, rb);
  const a = await startDaemon(ra.dir, { env: { HIVE_TEST_CHAMPION_HOME_MIN_INTERVAL_MS: "0" }, stopTimeoutMs: 30_000 }); handles.push(a);
  const A = await a.client(); clients.push(A);
  const infoA = await A.request<DeployInfoResult>("deployInfo");
  show("A0 deployInfo on a node with default config: champions are on, the v2 tag is advertised", { capabilities: infoA.capabilities.filter((c) => c.startsWith("champions")), champions: infoA.champions, configChampions: JSON.parse(readFileSync(join(ra.dir, "config.json"), "utf8")).champions });
  assert.ok(infoA.capabilities.includes("champions.v2") && infoA.capabilities.includes("champions.v1"));
  assert.deepEqual([infoA.champions?.enabled, infoA.champions?.homeSync], [true, true]);
  const template = await A.request<TemplatePutResult>("template.put", { fields: { name: "crew-role", agent: "cellstub", prompt: "You are the crew.", tags: ["team:crew"], env: { CREW_ROLE: "lab" } }, idempotencyKey: "tpl-a" });
  const put = await A.request<ChampionPutResult>("champion.put", { name: "Vera Lund", agent: "cellstub", model: "stub-1", effort: "high", templateId: template.template.id, idempotencyKey: "put-a" });
  show("A1 champion.put: identity, home under this executor's champions dir, template binding", { outcome: put.outcome, champion: put.champion, homeTree: tree(put.champion.home) });
  assert.equal(put.outcome, "created"); assert.equal(put.champion.id, "vera-lund"); assert.equal(put.champion.home, join(ra.homes, "vera-lund")); assert.equal(put.champion.templateId, template.template.id);
  const started = await ms(() => A.request<ChampionStartResult>("champion.start", { id: "vera-lund", prompt: "hello", idempotencyKey: "start-a" }));
  const viewA = await idle(A, started.result.beeId);
  show("A2 champion.start spawns the incarnation: bee kind champion, cwd = home, template args/env/tags plus the Champion's", { started: { ...started.result, champion: undefined }, ms: started.ms, bee: { id: viewA.bee?.id, kind: viewA.bee?.kind, cwd: viewA.bee?.cwd, tags: viewA.bee?.tags, args: viewA.bee?.args, envKeys: viewA.bee?.envKeys, agent: viewA.bee?.agent, name: viewA.bee?.name }, runtime: viewA.view.runtimeState });
  assert.equal(started.result.started, "spawned"); assert.equal(started.result.epoch, 0);
  assert.equal(viewA.bee?.kind, "champion"); assert.equal(viewA.bee?.cwd, put.champion.home);
  assert.ok(viewA.bee?.tags.includes("apiary:champion=vera-lund") && viewA.bee?.tags.includes("apiary:role=champion") && viewA.bee?.tags.includes("team:crew"));
  assert.deepEqual(viewA.bee?.args, ["--model", "stub-1", "--effort", "high"]);
  assert.ok(viewA.bee?.envKeys.includes("CREW_ROLE") && viewA.bee?.envKeys.includes("HIVE_CHAMPION_HOME"));
  const ordinary = await A.request<{ beeId: string }>("spawn", { name: "worker", agent: "cellstub", cwd: root });
  const ordinaryView = await A.request<ViewResult>("view", { beeId: ordinary.beeId });
  const refusals = {
    "spawn with kind: champion from a caller": await code(A.request("spawn", { name: "fake", agent: "cellstub", cwd: root, kind: "champion" })),
    "archive the incarnation directly": await code(A.request("archive", { beeId: started.result.beeId, idempotencyKey: "arch-direct" })),
    "delete the incarnation directly": await code(A.request("delete", { beeId: started.result.beeId, idempotencyKey: "del-direct" })),
    "template.delete while bound": await code(A.request("template.delete", { id: template.template.id, idempotencyKey: "tpl-del" })),
    "champion.export while the incarnation runs": await code(A.request("champion.export", { id: "vera-lund" })),
    "champion.start on the live incarnation": (await A.request<ChampionStartResult>("champion.start", { id: "vera-lund", idempotencyKey: "start-a2" })).started,
  };
  show("A3 resident lifecycle: an ordinary spawn is kind agent; the incarnation cannot be archived, deleted or exported out from under the Champion", { ordinaryKind: ordinaryView.bee?.kind, refusals });
  assert.equal(ordinaryView.bee?.kind, "agent");
  assert.match(refusals["spawn with kind: champion from a caller"], /^invalid_request/); assert.match(refusals["archive the incarnation directly"], /champion\.archive/); assert.match(refusals["delete the incarnation directly"], /champion\.archive/); assert.match(refusals["template.delete while bound"], /bound by Champion/); assert.match(refusals["champion.export while the incarnation runs"], /^runtime_refused/); assert.equal(refusals["champion.start on the live incarnation"], "running");
  await shIn(A, started.result.beeId, "printf 'Vera remembers the lab.\\n' >> MEMORY.md && printf 'fact one\\n' > memory/lab.md && mkdir -p notes && printf 'keep this\\n' > notes/plan.md && head -c 20000 /dev/urandom > blob.bin");
  const bundled = await waitFor(async () => { const g = await A.request<ChampionGetResult>("champion.get", { id: "vera-lund" }); return g.homeObjects.some((o) => o.files >= 4) ? g : null; }, "the turn end bundled the home", 30_000);
  const treeA = tree(put.champion.home);
  show("A4 the turn end bundled the home into A's own object store", { homeTree: treeA, bundle: bundled.homeObjects[0], inObjectStore: existsSync(join(ra.objects, "blobs", "champion-homes", bundled.homeObjects[0]!.ref)) });
  assert.equal(bundled.homeObjects[0]!.epoch, 0);

  note("\n# B. stop on A, export the quiet home, revive on executor B with the home intact");
  await A.request("stop", { beeId: started.result.beeId, idempotencyKey: "stop-a" });
  await stopped(A, started.result.beeId);
  const exported = await ms(() => A.request<ChampionExportResult>("champion.export", { id: "vera-lund" }));
  const bytes = Buffer.from(exported.result.homeBytes!, "base64");
  show("B1 champion.export on A: identity + template + the home bundle bytes (sha256 = home.ref)", { ms: exported.ms, champion: { id: exported.result.champion.id, epoch: exported.result.champion.epoch, currentBeeId: exported.result.champion.currentBeeId }, template: { id: exported.result.template?.id, name: exported.result.template?.name, prompt: exported.result.template?.prompt }, home: exported.result.home, bytes: bytes.length, sha256MatchesRef: sha(bytes) === exported.result.home!.ref });
  assert.equal(sha(bytes), exported.result.home!.ref); assert.equal(exported.result.home!.epoch, 0);
  const b = await startDaemon(rb.dir, { env: { HIVE_TEST_CHAMPION_HOME_MIN_INTERVAL_MS: "0" }, stopTimeoutMs: 30_000 }); handles.push(b);
  const B = await b.client(); clients.push(B);
  assert.deepEqual(await B.request<ChampionListResult>("champion.list", {}), { champions: [] });
  const tplB = await B.request<TemplatePutResult>("template.put", { fields: { name: exported.result.template!.name, agent: exported.result.template!.agent, prompt: exported.result.template!.prompt, tags: exported.result.template!.tags, env: exported.result.template!.env }, idempotencyKey: "tpl-b" });
  const putB = await B.request<ChampionPutResult>("champion.put", { id: exported.result.champion.id, name: exported.result.champion.name, agent: exported.result.champion.agent, model: exported.result.champion.model, effort: exported.result.champion.effort, templateId: tplB.template.id, idempotencyKey: "put-b" });
  const withoutBytes = await code(B.request("champion.start", { id: "vera-lund", homeRef: exported.result.home!.ref, epoch: exported.result.home!.epoch, idempotencyKey: "start-b0" }));
  const wrongBytes = await code(B.request("champion.start", { id: "vera-lund", homeRef: exported.result.home!.ref, epoch: exported.result.home!.epoch, homeBytes: Buffer.from("not the bundle").toString("base64"), idempotencyKey: "start-b1" }));
  const bytesWithoutHandover = await code(B.request("champion.start", { id: "vera-lund", homeBytes: exported.result.homeBytes, idempotencyKey: "start-b2" }));
  show("B2 executor B knows nothing of A: the identity is put again, and a start needs the bytes (no shared object store)", { putB: { outcome: putB.outcome, home: putB.champion.home, epoch: putB.champion.epoch }, "homeRef alone": withoutBytes, "bytes that do not hash to homeRef": wrongBytes, "homeBytes without homeRef/epoch": bytesWithoutHandover, homeTreeBefore: tree(putB.champion.home) });
  assert.match(withoutBytes, /hand it over as homeBytes/); assert.match(wrongBytes, /do not hash/); assert.match(bytesWithoutHandover, /needs homeRef and epoch/);
  const startedB = await ms(() => B.request<ChampionStartResult>("champion.start", { id: "vera-lund", homeRef: exported.result.home!.ref, homeBytes: exported.result.homeBytes, epoch: exported.result.home!.epoch, idempotencyKey: "start-b" }));
  const viewB = await idle(B, startedB.result.beeId);
  const treeB = tree(putB.champion.home);
  show("B3 champion.start on B with the bytes: the home is restored before the first runtime, B owns epoch 1, the incarnation is a champion-kind bee running in the restored home", { ms: startedB.ms, started: { ...startedB.result, champion: undefined }, bee: { id: viewB.bee?.id, kind: viewB.bee?.kind, cwd: viewB.bee?.cwd, args: viewB.bee?.args, tags: viewB.bee?.tags }, homeTreeOnB: treeB, sameFilesAsA: JSON.stringify(treeB) === JSON.stringify(treeA), objectAdoptedOnB: existsSync(join(rb.objects, "blobs", "champion-homes", exported.result.home!.ref)) });
  assert.equal(startedB.result.started, "spawned"); assert.equal(startedB.result.homeRestored, true); assert.equal(startedB.result.restoreSkipped, null); assert.equal(startedB.result.epoch, 1);
  assert.deepEqual(treeB, treeA, "every file the incarnation wrote on A is on B, byte for byte");
  assert.equal(viewB.bee?.kind, "champion"); assert.equal(viewB.bee?.cwd, putB.champion.home);
  await shIn(B, startedB.result.beeId, "cat MEMORY.md memory/lab.md notes/plan.md > seen.txt");
  const seen = readFileSync(join(putB.champion.home, "seen.txt"), "utf8");
  const bundleB = await waitFor(async () => { const g = await B.request<ChampionGetResult>("champion.get", { id: "vera-lund" }); return g.homeObjects.find((o) => o.epoch === 1) ?? null; }, "B bundles under its own epoch", 30_000);
  show("B4 the revived incarnation reads its memory on B; B's turn end bundles under epoch 1 into B's own store", { seen, bundleB, pointerForAdoptedBundle: (await B.request<ChampionGetResult>("champion.get", { id: "vera-lund" })).homeObjects.some((o) => o.ref === exported.result.home!.ref) });
  assert.equal(seen, "# Memory\nVera remembers the lab.\nfact one\nkeep this\n");

  note("\n# C. the old executor is fenced; a stale epoch cannot take the incarnation back; the snapshot and the CLI see the kind");
  const fenced = await A.request<ChampionFenceResult>("champion.fence", { id: "vera-lund", epoch: startedB.result.epoch, idempotencyKey: "fence-a" });
  const afterFence = {
    fence: { epoch: fenced.champion.epoch, fencedAt: fenced.champion.fencedAt != null, stoppedLive: fenced.stopped },
    "champion.start on fenced A": await code(A.request("champion.start", { id: "vera-lund", idempotencyKey: "start-a-fenced" })),
    "handover with the stale epoch 0 on A": await code(A.request("champion.start", { id: "vera-lund", homeRef: exported.result.home!.ref, epoch: 0, idempotencyKey: "start-a-stale" })),
    "fence with an older epoch": await code(A.request("champion.fence", { id: "vera-lund", epoch: 0, idempotencyKey: "fence-old" })),
    "export of the fenced home answers the last bundle taken before the fence (epoch 0), bundling nothing new under the fenced epoch": await (async () => { const e = await A.request<ChampionExportResult>("champion.export", { id: "vera-lund" }); return e.home?.ref === exported.result.home!.ref && e.home.epoch === 0 ? "ok, same ref, epoch 0" : `unexpected ${e.home?.ref.slice(0, 12)} epoch ${e.home?.epoch}`; })(),
  };
  show("C1 fence on A", afterFence);
  assert.match(afterFence["champion.start on fenced A"], /^champion_fenced/); assert.match(afterFence["handover with the stale epoch 0 on A"], /^champion_fenced/); assert.match(afterFence["fence with an older epoch"], /^champion_fenced/);
  const snapshotB = await B.request<SnapshotResult>("snapshot", {});
  const beeRowB = snapshotB.views.find((v) => v.view.beeId === startedB.result.beeId);
  show("C2 snapshot on B: the champions table and the champion-kind bee record", { champions: snapshotB.champions?.map((c) => ({ id: c.id, epoch: c.epoch, currentBeeId: c.currentBeeId, templateId: c.templateId })), beeRecord: { id: beeRowB?.bee?.id, kind: beeRowB?.bee?.kind, name: beeRowB?.bee?.name } });
  assert.equal(snapshotB.champions?.[0]?.currentBeeId, startedB.result.beeId); assert.equal(beeRowB?.bee?.kind, "champion");
  await B.request("stop", { beeId: startedB.result.beeId, idempotencyKey: "stop-b" });
  await stopped(B, startedB.result.beeId);
  const out: string[] = [], err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const exportFile = join(root, "vera-lund.export.json");
  const rc1 = await runV2Cli(["--data-dir", rb.dir, "champion", "export", "vera-lund", "--out", exportFile], io);
  const rc2 = await runV2Cli(["--data-dir", rb.dir, "champion", "list"], io);
  const rc3 = await runV2Cli(["--data-dir", rb.dir, "view", startedB.result.beeId], io);
  const rc4 = await runV2Cli(["--data-dir", rb.dir, "champion", "start", "vera-lund", "--prompt", "back"], io);
  const revived = await idle(B, startedB.result.beeId);
  const exportedFile = JSON.parse(readFileSync(exportFile, "utf8")) as ChampionExportResult;
  show("C3 CLI on B: champion export --out (0600, redacted on screen), champion list, view shows kind, champion start revives the stopped incarnation", { rc: [rc1, rc2, rc3, rc4], out, err, exportFileMode: (statSync(exportFile).mode & 0o777).toString(8), exportFileHasBytes: typeof exportedFile.homeBytes === "string" && exportedFile.homeBytes.length > 0, exportFileEpoch: exportedFile.home?.epoch, revived: { runtime: revived.view.runtimeState, generation: revived.view.generation, sameBee: revived.view.beeId === startedB.result.beeId } });
  assert.deepEqual([rc1, rc2, rc3, rc4], [0, 0, 0, 0]); assert.ok(out.some((l) => /kind\s+champion/.test(l)), "hive view prints the kind"); assert.ok(!out.some((l) => l.includes(exportedFile.homeBytes!.slice(0, 40))), "the bytes stay out of the terminal");
  assert.equal(exportedFile.home?.epoch, 1); assert.equal(revived.view.beeId, startedB.result.beeId);
  await A.request("delete", { beeId: ordinary.beeId, idempotencyKey: "del-worker" }).catch(() => undefined);
  await a.stop(); await b.stop();
  note("\nALL CHECKS PASSED");
} finally { await cleanup(); }
