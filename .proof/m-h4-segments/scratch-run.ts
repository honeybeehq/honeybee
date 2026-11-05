/**
 * M-H4 scratch-daemon run: a real daemon with its own data dir and socket, stub
 * bees, real turns. Records: the advertised tags, segment objects on disk,
 * transcript.segment.ready deltas (turn end -> ready latency), the daemon's CPU
 * seconds over the turns, the kill-by-pid read-back from objects alone, and the
 * boot catch-up after a restart.
 *
 * MODE=after (this checkout) or MODE=before-on / MODE=before-off (an origin/main
 * worktree with transcripts.segments.enabled true / false). BEES, TURNS tune size.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decompressSegment } from "../../v2/driver-tmux/src/transcript-segment-format.ts";
import { createDirectoryTranscriptObjectStore } from "../../v2/daemon/src/transcriptObjectStore.ts";
import type { AuditTailResult, DeployInfoResult, SpawnResult, TranscriptSegmentsResult, ViewResult } from "../../v2/daemon/src/protocol.ts";
import { runV2Cli, type CliIo } from "../../v2/cli/src/main.ts";
import type { RpcClient } from "../../v2/cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../v2/daemon/tests/helpers.ts";

const MODE = process.env.MODE ?? "after";
const BEES = Number(process.env.BEES ?? 20);
const TURNS = Number(process.env.TURNS ?? 5);
const OUT = process.env.OUT ?? `scratch-${MODE}.json`;

function cpuSeconds(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[11]) + Number(fields[12]);
  return ticks / 100;
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function nonBlankLines(path: string, upTo?: number): string[] {
  return readFileSync(path).subarray(0, upTo ?? undefined).toString("utf8").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim().length > 0);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

async function allAudit(client: RpcClient, beeIds: string[]): Promise<AuditTailResult["rows"]> {
  const rows: AuditTailResult["rows"] = [];
  for (const beeId of beeIds) {
    const page = (await client.request<AuditTailResult>("audit.tail", { afterSeq: 0, limit: 1000, beeId })).rows;
    if (page.length >= 1000) throw new Error(`audit tail for ${beeId} is truncated`);
    rows.push(...page);
  }
  return rows.sort((a, b) => a.seq - b.seq);
}

async function idle(client: RpcClient, beeId: string): Promise<ViewResult> {
  return waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === "idle" ? v : null;
  }, `idle ${beeId}`, 60_000);
}

async function talk(client: RpcClient, beeId: string, body: string): Promise<number> {
  const before = (await client.request<ViewResult>("view", { beeId })).view.lastOutputAt ?? 0;
  await client.request("send", { beeId, body, urgency: "next" });
  const v = await waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === "idle" && (v.view.lastOutputAt ?? 0) > before ? v : null;
  }, `turn ${body} on ${beeId}`, 60_000);
  return v.view.lastOutputAt!;
}

async function main(): Promise<void> {
  const segmentsConfig: Record<string, unknown> = { maxLines: 3 };
  if (MODE === "before-on") segmentsConfig.enabled = true;
  if (MODE === "before-off") segmentsConfig.enabled = false;
  const { dir, cleanup } = makeDaemonDir({ transcripts: { segments: segmentsConfig } });
  const report: Record<string, unknown> = { mode: MODE, bees: BEES, turns: TURNS, dir, startedAt: new Date().toISOString() };
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: { HIVE_TEST_TRANSCRIPT_SWEEP_DELAY_MS: "0" } });
    let client = await daemon.client();
    const info = await client.request<DeployInfoResult>("deployInfo");
    report.pid = info.pid;
    report.capabilities = { v1: info.capabilities.includes("transcript.segments.v1"), v2: info.capabilities.includes("transcript.segments.v2") };
    report.status = info.transcriptSegments;
    report.configHasEnabledKey = "enabled" in segmentsConfig;

    const beeIds: string[] = [];
    for (let i = 0; i < BEES; i += 1) beeIds.push((await client.request<SpawnResult>("spawn", { name: `talker-${i}`, agent: "stub", cwd: dir })).beeId);
    for (const beeId of beeIds) await idle(client, beeId);

    const cpuStart = cpuSeconds(info.pid);
    const wallStart = Date.now();
    const turnEnds: Array<{ beeId: string; lastOutputAt: number }> = [];
    for (let t = 0; t < TURNS; t += 1) {
      for (const beeId of beeIds) turnEnds.push({ beeId, lastOutputAt: await talk(client, beeId, `turn ${t} ${"x".repeat(200)}`) });
    }
    const wallTurns = Date.now() - wallStart;
    const expectLines = new Map<string, number>();
    for (const beeId of beeIds) {
      const view = await client.request<ViewResult>("view", { beeId });
      expectLines.set(beeId, nonBlankLines(view.bee!.sessionLogPath!).length);
    }
    const segmentsOn = MODE !== "before-off";
    let totalSegments = 0;
    const rowsByBee = new Map<string, TranscriptSegmentsResult["segments"]>();
    if (segmentsOn) {
      for (const beeId of beeIds) {
        const r = await waitFor(async () => {
          const r = await client.request<TranscriptSegmentsResult>("transcript.segments", { beeId });
          return r.segments.length > 0 && r.segments[r.segments.length - 1]!.lastLine >= expectLines.get(beeId)! ? r : null;
        }, `segments cover ${beeId}`, 120_000);
        rowsByBee.set(beeId, r.segments);
        totalSegments += r.segments.length;
      }
      await waitFor(async () => ((await client.request<DeployInfoResult>("deployInfo")).transcriptSegments?.backlog === 0 ? true : null), "backlog drained", 120_000);
    } else {
      await new Promise((r) => setTimeout(r, 1000));
    }
    const cpuTurns = cpuSeconds(info.pid) - cpuStart;
    report.turns = { wallMs: wallTurns, daemonCpuSeconds: Number(cpuTurns.toFixed(3)), totalSegments, turnEnds: turnEnds.length };

    const audit = await allAudit(client, beeIds);
    const ready = audit.filter((r) => r.kind === "transcript.segment.ready");
    const puts = audit.filter((r) => r.kind === "transcript_segment_object.put");
    const latencies: number[] = [];
    const announced = new Map<string, number[]>();
    for (const row of ready) {
      const ordinals = (row.payload.segments as Array<{ ordinal: number }>).map((s) => s.ordinal);
      announced.set(row.beeId!, [...(announced.get(row.beeId!) ?? []), ...ordinals]);
      const turn = [...turnEnds].reverse().find((t) => t.beeId === row.beeId && t.lastOutputAt <= row.ts);
      if (turn) latencies.push(row.ts - turn.lastOutputAt);
    }
    const announcedComplete = segmentsOn && beeIds.every((b) => JSON.stringify(announced.get(b) ?? []) === JSON.stringify((rowsByBee.get(b) ?? []).map((r) => r.ordinal)));
    const putLatencies: number[] = [];
    for (const row of puts) {
      const turn = [...turnEnds].reverse().find((t) => t.beeId === row.beeId && t.lastOutputAt <= row.ts);
      if (turn) putLatencies.push(row.ts - turn.lastOutputAt);
    }
    report.deltas = {
      readyRows: ready.length,
      readyReasons: [...new Set(ready.map((r) => r.payload.reason))],
      readyAnnouncesEverySegmentInOrder: announcedComplete,
      putRows: puts.length,
      readyLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: percentile(latencies, 1) },
      putLatencyMs: { p50: percentile(putLatencies, 0.5), p95: percentile(putLatencies, 0.95), max: percentile(putLatencies, 1) },
    };

    const root = join(dir, "transcript-objects");
    const blobs = join(root, "blobs", "transcript-archives");
    let objectBytes = 0;
    let objectCount = 0;
    if (existsSync(blobs)) for (const name of readdirSync(blobs)) { objectCount += 1; objectBytes += statSync(join(blobs, name)).size; }
    let byteExact = segmentsOn;
    if (segmentsOn) {
      const objects = createDirectoryTranscriptObjectStore(root);
      for (const beeId of beeIds) {
        const log = readFileSync((await client.request<ViewResult>("view", { beeId })).bee!.sessionLogPath!);
        for (const row of rowsByBee.get(beeId)!) {
          const rawCompressed = objects.read(row.rawRef);
          const projected = objects.read(row.projectedRef);
          if (!rawCompressed || !projected) { byteExact = false; continue; }
          if (createHash("sha256").update(rawCompressed).digest("hex") !== row.rawRef) byteExact = false;
          if (!decompressSegment(rawCompressed).equals(log.subarray(row.byteStart, row.byteEnd))) byteExact = false;
        }
      }
    }
    report.objects = { dirExists: existsSync(blobs), count: objectCount, bytes: objectBytes, rawAndProjectedByteExact: byteExact };
    const stopped = beeIds.slice(0, Math.floor(beeIds.length / 2));
    for (const beeId of stopped) await client.request("stop", { beeId });
    for (const beeId of stopped) await waitFor(async () => ((await client.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped" ? true : null), `stopped ${beeId}`, 60_000);
    if (segmentsOn) await waitFor(async () => ((await client.request<DeployInfoResult>("deployInfo")).transcriptSegments?.backlog === 0 ? true : null), "exit cuts drained", 120_000);
    report.stoppedBeforeKill = stopped.length;
    const hivedLengthBeforeKill = readFileSync(join(dir, "hived.log"), "utf8").length;
    client.close();

    const pid = info.pid;
    process.kill(pid, "SIGKILL");
    await waitFor(() => (daemon!.proc.exitCode != null || daemon!.proc.signalCode != null ? true : null), "daemon killed by pid", 10_000);
    const sample = beeIds[Math.floor(beeIds.length / 2)]!;
    const sampleRows = rowsByBee.get(sample) ?? [];
    const cli = capture();
    const code = await runV2Cli(["transcript", sample, "--from-objects", "--raw", "--data-dir", dir], cli.io);
    const view = segmentsOn ? sampleRows[sampleRows.length - 1] : undefined;
    let readBackMatches: boolean | null = null;
    if (segmentsOn && view) {
      const logFile = sampleRows[0]!.path;
      readBackMatches = JSON.stringify(cli.out) === JSON.stringify(nonBlankLines(logFile, view.byteEnd));
    }
    report.killedDaemon = { signal: "SIGKILL", pid, cliExit: code, stale: cli.err.some((l) => l.startsWith("STALE")), linesFromObjects: cli.out.length, readBackMatchesLogToLastSegment: readBackMatches, sampleBee: sample };

    const bootStart = Date.now();
    daemon = await startDaemon(dir, { env: { HIVE_TEST_TRANSCRIPT_SWEEP_DELAY_MS: "0" } });
    client = await daemon.client();
    const info2 = await client.request<DeployInfoResult>("deployInfo");
    const cpuBootStart = cpuSeconds(info2.pid);
    const hivedLog = () => readFileSync(join(dir, "hived.log"), "utf8");
    const catchUp = await waitFor(() => { const m = hivedLog().match(/transcripts\.segment\.catch_up scheduled=(\d+)/g); return m ? m[m.length - 1] : null; }, "catch-up line", 30_000).catch(() => null);
    if (segmentsOn) await waitFor(async () => ((await client.request<DeployInfoResult>("deployInfo")).transcriptSegments?.backlog === 0 ? true : null), "boot backlog drained", 120_000);
    await new Promise((r) => setTimeout(r, 1500));
    const bootWall = Date.now() - bootStart;
    const bootCpu = cpuSeconds(info2.pid) - cpuBootStart;
    const afterBoot = hivedLog().slice(hivedLengthBeforeKill);
    const cutLines = (afterBoot.match(/transcripts\.segment\.cut bee=/g) ?? []).length;
    const bootAudit = await allAudit(client, beeIds);
    const bootReady = bootAudit.filter((r) => r.kind === "transcript.segment.ready" && r.payload.reason === "boot").length;
    const bootPuts = bootAudit.filter((r) => r.kind === "transcript_segment_object.put").length - puts.length;
    report.restart = { stoppedBees: stopped.length, catchUpLine: catchUp, cutsLoggedAfterBoot: cutLines, wallMsToDrained: bootWall, daemonCpuSecondsAfterBoot: Number(bootCpu.toFixed(3)), bootReadyRows: bootReady, putRowsAfterBoot: bootPuts };
    client.close();
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
}

await main();
