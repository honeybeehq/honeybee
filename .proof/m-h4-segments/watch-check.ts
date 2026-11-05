/**
 * M-H4 watch check: a watcher on a scratch daemon receives transcript.segment.ready
 * as a delta frame after a turn ends, carrying the segment rows and the cursor.
 */
import { writeFileSync } from "node:fs";
import type { DeployInfoResult, SpawnResult, ViewResult, WatchFrame } from "../../v2/daemon/src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../v2/daemon/tests/helpers.ts";

const OUT = process.env.OUT ?? "watch-check.json";

async function main(): Promise<void> {
  const { dir, cleanup } = makeDaemonDir({ transcripts: { segments: { maxLines: 2 } } });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const watcher = await daemon.client();
    const frames: WatchFrame[] = [];
    watcher.onEvent = (frame) => frames.push(frame);
    await watcher.request("watch");
    const client = await daemon.client();
    const info = await client.request<DeployInfoResult>("deployInfo");
    const spawned = await client.request<SpawnResult>("spawn", { name: "watched", agent: "stub", cwd: dir });
    const beeId = spawned.beeId;
    await waitFor(async () => ((await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle" ? true : null), "idle", 60_000);
    const sentAt = Date.now();
    await client.request("send", { beeId, body: "hello from the watch check", urgency: "next" });
    const ready = await waitFor(() => {
      for (const frame of frames) {
        if (frame.type !== "delta") continue;
        const event = frame.events.find((e) => e.kind === "transcript.segment.ready" && e.beeId === beeId);
        if (event) return { frameSeq: frame.seq, event };
      }
      return null;
    }, "transcript.segment.ready delta", 60_000);
    const segments = (ready.event.payload.segments as Array<Record<string, unknown>>).map((s) => ({ ordinal: s.ordinal, firstLine: s.firstLine, lastLine: s.lastLine, rawRef: s.rawRef, projectedRef: s.projectedRef }));
    const report = {
      capabilities: { v2: info.capabilities.includes("transcript.segments.v2") },
      beeId,
      msFromSendToReadyDelta: Date.now() - sentAt,
      frameSeq: ready.frameSeq,
      deltaSeq: ready.event.seq,
      reason: ready.event.payload.reason,
      fromOrdinal: ready.event.payload.fromOrdinal,
      toOrdinal: ready.event.payload.toOrdinal,
      cursor: ready.event.payload.cursor,
      segments,
      deltaFramesSeen: frames.filter((f) => f.type === "delta").length,
      gapFramesSeen: frames.filter((f) => f.type !== "delta").length,
    };
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    watcher.close();
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
}

await main();
