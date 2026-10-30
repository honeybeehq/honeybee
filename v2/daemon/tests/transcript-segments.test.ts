/**
 * H4 transcript segment objects in the REAL daemon: turn ends cut the session
 * log into dense, byte-exact raw + projected objects in the directory store with
 * pointer rows and audit deltas; a killed daemon's bee still reads to its last
 * segment from the objects alone (read-only store + store directory); a restart
 * resumes the cursor without gaps or duplicates; the flag off cuts nothing.
 * Temp dirs and stub agents only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeProjectedSegment, decompressSegment, segmentDigest } from "../../driver-tmux/src/transcript-segment-format.ts";
import { createDirectoryTranscriptObjectStore } from "../src/transcriptObjectStore.ts";
import { DAEMON_CAPABILITIES, RPC_VERBS, type AuditTailResult, type DeployInfoResult, type HealthResult, type SpawnResult, type TranscriptSegmentsResult, type ViewResult } from "../src/protocol.ts";
import { runV2Cli, type CliIo } from "../../cli/src/main.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

async function idle(client: RpcClient, beeId: string): Promise<ViewResult> {
  return waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === "idle" ? v : null;
  }, "idle", 60_000);
}

async function talk(client: RpcClient, beeId: string, body: string): Promise<void> {
  const before = (await client.request<ViewResult>("view", { beeId })).view.lastOutputAt ?? 0;
  await client.request("send", { beeId, body, urgency: "next" });
  await waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === "idle" && (v.view.lastOutputAt ?? 0) > before ? v : null;
  }, `turn for ${body} ended`, 60_000);
}

const segments = (client: RpcClient, beeId: string) => client.request<TranscriptSegmentsResult>("transcript.segments", { beeId });

function nonBlankLines(path: string, upTo?: number): string[] {
  const text = readFileSync(path).subarray(0, upTo ?? undefined).toString("utf8");
  return text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim().length > 0);
}

test("transcript-segments.0: verb and capability are published", () => {
  assert.ok(RPC_VERBS.includes("transcript.segments"));
  assert.ok((DAEMON_CAPABILITIES as readonly string[]).includes("transcript.segments.v1"));
});

test("transcript-segments.1: turn ends cut dense byte-exact segments; a killed daemon's bee reads to its last segment from the objects alone; a restart resumes without gaps", { timeout: 180_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir({ transcripts: { segments: { enabled: true, maxLines: 3 } } });
  let daemon: DaemonHandle | null = null;
  try {
    const blobs = join(dir, "transcript-objects", "blobs", "transcript-archives");
    mkdirSync(blobs, { recursive: true });
    const orphan = join(blobs, "f".repeat(64));
    writeFileSync(orphan, "stale");
    const old = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(orphan, old, old);
    daemon = await startDaemon(dir, { env: { HIVE_TEST_TRANSCRIPT_SWEEP_DELAY_MS: "0" } });
    let client = await daemon.client();
    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.equal(info.transcriptSegments?.enabled, true);
    assert.equal(info.transcriptSegments?.store?.root, join(dir, "transcript-objects"));
    assert.equal(info.transcriptSegments?.maxLines, 3);
    const spawned = await client.request<SpawnResult>("spawn", { name: "talker", agent: "stub", cwd: dir });
    const beeId = spawned.beeId;
    await idle(client, beeId);
    for (const body of ["one", "two", "three"]) await talk(client, beeId, body);
    const view = await client.request<ViewResult>("view", { beeId });
    const logPath = view.bee!.sessionLogPath!;
    const logLines = nonBlankLines(logPath);
    const result = await waitFor(async () => {
      const r = await segments(client, beeId);
      return r.segments.length > 0 && r.segments[r.segments.length - 1]!.lastLine >= logLines.length ? r : null;
    }, "segments cover the log", 30_000);
    assert.equal(result.store?.root, join(dir, "transcript-objects"));
    const rows = result.segments;
    assert.deepEqual(rows.map((r) => r.ordinal), rows.map((_, i) => i), "ordinals are dense");
    assert.equal(rows[0]!.firstLine, 1);
    for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i]!.firstLine, rows[i - 1]!.lastLine + 1, "line numbers are contiguous across segments");
    assert.ok(rows.every((r) => r.lastLine - r.firstLine + 1 <= 3), "maxLines bounds every segment");
    assert.ok(rows.some((r) => r.lastLine - r.firstLine + 1 === 3), "a long turn fills segments to the cap");
    assert.equal(rows[rows.length - 1]!.lastLine, logLines.length, "every complete line is cut at turn end");
    const log = readFileSync(logPath);
    const objects = createDirectoryTranscriptObjectStore(result.store!.root);
    for (const row of rows) {
      const rawCompressed = objects.read(row.rawRef)!;
      assert.ok(rawCompressed, `raw object ${row.rawRef} exists`);
      assert.equal(createHash("sha256").update(rawCompressed).digest("hex"), row.rawRef, "refs are content addresses of the stored bytes");
      assert.equal(rawCompressed.length, row.rawBytes);
      const raw = decompressSegment(rawCompressed);
      assert.equal(raw.length, row.rawSize);
      assert.ok(raw.equals(log.subarray(row.byteStart, row.byteEnd)), `raw object ${row.ordinal} is the exact log range`);
      const projected = decodeProjectedSegment(decompressSegment(objects.read(row.projectedRef)!));
      assert.equal(projected.beeId, beeId);
      assert.equal(projected.harness, "stub");
      assert.equal(projected.projectionVersion, row.projectionVersion);
      assert.deepEqual(projected.lines.map((l) => l.line_no), Array.from({ length: row.lastLine - row.firstLine + 1 }, (_, i) => row.firstLine + i));
      assert.equal(segmentDigest(projected.lines), row.digest);
      assert.equal(row.path, logPath);
      for (const line of projected.lines) {
        const text = log.subarray(line.byte_offset, line.byte_offset + line.raw_bytes).toString("utf8");
        assert.equal(createHash("sha256").update(text, "utf8").digest("hex"), line.raw_sha256, "per-line digests match the log");
        assert.ok(Array.isArray(JSON.parse(line.events)));
      }
    }
    const audits = (await client.request<AuditTailResult>("audit.tail", { limit: 500 })).rows.filter((r) => r.kind === "transcript_segment_object.put");
    assert.equal(audits.length, rows.length, "one pointer delta per segment");
    const swept = await waitFor(async () => {
      const status = (await client.request<DeployInfoResult>("deployInfo")).transcriptSegments;
      return status?.objects && !existsSync(orphan) ? status : null;
    }, "the orphan sweep ran once the backlog drained", 30_000);
    assert.equal(swept.objects!.orphansSwept, 1, "the stale unreferenced object is gone");
    assert.equal(swept.objects!.objects, rows.length * 2, "every raw and projected object is counted");
    assert.ok(swept.objects!.bytes > 0);
    assert.equal(swept.backlog, 0);
    const health = await client.request<HealthResult>("health");
    assert.equal(health.capacity?.transcriptObjects?.objects, rows.length * 2, "the capacity fact carries the object store");
    assert.equal(result.cursor?.lineNo, rows[rows.length - 1]!.lastLine);
    assert.equal(result.cursor?.byteOffset, rows[rows.length - 1]!.byteEnd);
    client.close();

    await daemon.kill();
    daemon = null;
    const cli = capture();
    assert.equal(await runV2Cli(["transcript", beeId, "--from-objects", "--raw", "--data-dir", dir], cli.io), 0, cli.err.join("\n"));
    assert.ok(cli.err.some((l) => l.startsWith("STALE")), "the daemon is dead; the read is labeled stale");
    assert.deepEqual(cli.out, nonBlankLines(logPath, rows[rows.length - 1]!.byteEnd), "the objects alone reproduce the transcript to the last segment");
    const listed = capture();
    assert.equal(await runV2Cli(["transcript", beeId, "--segments", "--data-dir", dir], listed.io), 0);
    assert.equal(listed.out.length, rows.length + 1);
    const rendered = capture();
    assert.equal(await runV2Cli(["transcript", beeId, "--from-objects", "--data-dir", dir], rendered.io), 0);
    assert.ok(rendered.out.length > 0, "the projected objects render without the daemon");

    daemon = await startDaemon(dir);
    client = await daemon.client();
    await waitFor(async () => (await segments(client, beeId)).segments.length === rows.length ? true : null, "boot catch-up cuts nothing new when the log did not grow", 30_000);
    await talk(client, beeId, "four");
    const after = await waitFor(async () => {
      const r = await segments(client, beeId);
      return r.segments.length > rows.length ? r : null;
    }, "the next turn is cut after the restart", 30_000);
    const grown = nonBlankLines(logPath);
    assert.equal(after.segments[rows.length]!.firstLine, rows[rows.length - 1]!.lastLine + 1, "the cursor resumed exactly where it stopped");
    assert.deepEqual(after.segments.map((r) => r.ordinal), after.segments.map((_, i) => i));
    assert.equal(after.segments[after.segments.length - 1]!.lastLine, grown.length);
    const seen = new Set<number>();
    for (const row of after.segments) for (let l = row.firstLine; l <= row.lastLine; l += 1) { assert.ok(!seen.has(l), `line ${l} appears once`); seen.add(l); }
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("transcript-segments.2: with the flag off nothing is cut and no store appears; the status says so", { timeout: 120_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.equal(info.transcriptSegments?.enabled, false);
    assert.equal(info.transcriptSegments?.store, null);
    const spawned = await client.request<SpawnResult>("spawn", { name: "quiet", agent: "stub", cwd: dir });
    await idle(client, spawned.beeId);
    await talk(client, spawned.beeId, "hello");
    await new Promise((r) => setTimeout(r, 500));
    const r = await segments(client, spawned.beeId);
    assert.deepEqual(r.segments, []);
    assert.equal(r.store, null);
    assert.equal(existsSync(join(dir, "transcript-objects")), false);
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
