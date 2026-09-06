import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError } from "../src/protocol.ts";
import {
  createPerformanceProfiler,
  NOOP_PERFORMANCE,
  type PerformanceProfiler,
} from "../src/performance.ts";
import { RpcServer } from "../src/rpc.ts";
import {
  makeDaemonDir,
  sleep,
  startDaemon,
  waitFor,
  type DaemonHandle,
} from "./helpers.ts";

const SECRET_PARAM = "prompt-secret-that-must-not-appear";
const SECRET_ERROR = "provider-error-detail-that-must-not-appear";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number") assert.fail(`${label} must be a number`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") assert.fail(`${label} must be a string`);
  return value;
}

interface ArtifactPair {
  trace: Record<string, unknown>;
  summary: Record<string, unknown>;
  traceText: string;
  summaryText: string;
  totalBytes: number;
}

function readArtifacts(directory: string): ArtifactPair {
  const names = readdirSync(directory).sort();
  assert.equal(names.length, 2, `expected one trace and one summary: ${names.join(", ")}`);
  const traceName = names.find((name) => name.endsWith(".trace.json"));
  const summaryName = names.find((name) => name.endsWith(".summary.json"));
  assert.ok(traceName, "trace artifact missing");
  assert.ok(summaryName, "summary artifact missing");
  const tracePath = join(directory, traceName);
  const summaryPath = join(directory, summaryName);
  const traceText = readFileSync(tracePath, "utf8");
  const summaryText = readFileSync(summaryPath, "utf8");
  return {
    trace: requireRecord(parseJson(traceText), "trace"),
    summary: requireRecord(parseJson(summaryText), "summary"),
    traceText,
    summaryText,
    totalBytes: statSync(tracePath).size + statSync(summaryPath).size,
  };
}

function traceEvents(artifact: ArtifactPair): Record<string, unknown>[] {
  const events = artifact.trace.traceEvents;
  assert.ok(Array.isArray(events), "traceEvents must be an array");
  return events.map((event, index) => requireRecord(event, `trace event ${index}`));
}

function spanSummary(
  artifact: ArtifactPair,
  name: string,
): Record<string, unknown> {
  const spans = requireRecord(artifact.summary.spans, "summary spans");
  return requireRecord(spans[name], `span ${name}`);
}

function exerciseSpans(profiler: PerformanceProfiler, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const span = profiler.startSpan("daemon.tick.total");
    span.end(index === 1 ? "error" : "ok");
  }
}

test("profiling is inert without HIVE_PERF_DIR", () => {
  const directory = mkdtempSync(join(tmpdir(), "hb-perf-disabled-"));
  try {
    const diagnostics: string[] = [];
    const profiler = createPerformanceProfiler({
      env: { HIVE_PERF_MAX_EVENTS: "1" },
      log: (operation) => diagnostics.push(operation),
    });
    assert.equal(profiler, NOOP_PERFORMANCE);
    profiler.start();
    assert.equal(
      profiler.measureSync("daemon.tick.total", () => 42),
      42,
    );
    profiler.stop();
    assert.deepEqual(readdirSync(directory), []);
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("profiling IO failures are fail-open and log one generic diagnostic", () => {
  const directory = mkdtempSync(join(tmpdir(), "hb-perf-io-"));
  try {
    const blocker = join(directory, "not-a-directory");
    writeFileSync(blocker, "block");
    const diagnostics: string[] = [];
    const profiler = createPerformanceProfiler({
      env: { HIVE_PERF_DIR: join(blocker, SECRET_PARAM) },
      log: (operation) => diagnostics.push(operation),
    });
    profiler.start();
    assert.equal(
      profiler.measureSync("daemon.tick.total", () => "unchanged"),
      "unchanged",
    );
    profiler.stop();
    profiler.stop();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0], "performance.disabled reason=io_or_setup_failure");
    assert.ok(!diagnostics[0]?.includes(SECRET_PARAM));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("event caps preserve exact recorded aggregates and count drops", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-perf-events-"));
  const directory = join(root, "artifacts");
  try {
    const profiler = createPerformanceProfiler({
      env: { HIVE_PERF_DIR: directory },
      log: () => undefined,
      limits: {
        durationMs: 60_000,
        sampleIntervalMs: 60_000,
        maxEvents: 3,
        maxArtifactBytes: 64 * 1024,
      },
    });
    profiler.start();
    exerciseSpans(profiler, 10);
    profiler.stop();

    const artifact = readArtifacts(directory);
    const events = traceEvents(artifact);
    assert.equal(events.length, 3);
    assert.equal(artifact.summary.stopReason, "event_limit");
    assert.equal(requireNumber(artifact.summary.traceEvents, "traceEvents"), 3);
    assert.equal(requireNumber(artifact.summary.droppedEvents, "droppedEvents"), 7);
    const stats = spanSummary(artifact, "daemon.tick.total");
    assert.equal(requireNumber(stats.count, "span count"), 3);
    assert.equal(requireNumber(stats.errors, "span errors"), 1);
    assert.ok(BigInt(requireString(stats.totalNanoseconds, "span total")) > 0n);
    assert.ok(BigInt(requireString(stats.maxNanoseconds, "span max")) > 0n);
    assert.ok(Array.isArray(stats.bucketCounts));
    assert.equal(
      stats.bucketCounts.reduce<number>(
        (sum, count) => sum + requireNumber(count, "bucket count"),
        0,
      ),
      3,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact byte caps bound both files and report dropped events", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-perf-bytes-"));
  const directory = join(root, "artifacts");
  const maxArtifactBytes = 64 * 1024;
  try {
    const profiler = createPerformanceProfiler({
      env: { HIVE_PERF_DIR: directory },
      log: () => undefined,
      limits: {
        durationMs: 60_000,
        sampleIntervalMs: 60_000,
        maxEvents: 1_000_000,
        maxArtifactBytes,
      },
    });
    profiler.start();
    exerciseSpans(profiler, 2_000);
    profiler.stop();

    const artifact = readArtifacts(directory);
    assert.ok(artifact.totalBytes <= maxArtifactBytes);
    assert.equal(artifact.summary.stopReason, "artifact_byte_limit");
    assert.ok(requireNumber(artifact.summary.droppedEvents, "droppedEvents") > 0);
    assert.ok(traceEvents(artifact).length < 2_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RPC serialization profiling covers responses and watcher frames", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-perf-serialize-"));
  const directory = join(root, "artifacts");
  const socketPath = join(root, "rpc.sock");
  const profiler = createPerformanceProfiler({
    env: { HIVE_PERF_DIR: directory },
    log: () => undefined,
    limits: { durationMs: 60_000, sampleIntervalMs: 60_000 },
  });
  const server = new RpcServer({
    socketPath,
    log: () => undefined,
    performance: profiler,
    dispatch: (verb, _params, conn) => {
      assert.equal(verb, "watch");
      conn.subscribeWatch(0);
      return { seq: 0, secret: SECRET_PARAM };
    },
  });
  let client: RpcClient | null = null;
  let watchFrames = 0;
  try {
    profiler.start();
    await server.listen();
    client = await RpcClient.connect(socketPath);
    client.onEvent = () => {
      watchFrames += 1;
    };
    await client.request("watch");
    server.flushWatch(
      1,
      () => [
        {
          seq: 1,
          ts: Date.now(),
          kind: "performance.test",
          beeId: null,
          payload: { secret: SECRET_PARAM },
        },
      ],
      10,
    );
    await waitFor(() => watchFrames === 1, "profiled watch frame", 1_000);
  } finally {
    client?.close();
    await server.close();
    profiler.stop();
  }

  try {
    const artifact = readArtifacts(directory);
    const stats = spanSummary(artifact, "rpc.serialize");
    assert.equal(requireNumber(stats.count, "serialize count"), 3);
    assert.equal(requireNumber(stats.errors, "serialize errors"), 0);
    assert.equal(
      traceEvents(artifact).filter((event) => event.name === "rpc.serialize").length,
      3,
    );
    assert.ok(!artifact.traceText.includes(SECRET_PARAM));
    assert.ok(!artifact.summaryText.includes(SECRET_PARAM));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("storage startup failures end the active phase as an error", async () => {
  const { dir, cleanup } = makeDaemonDir();
  const directory = join(dir, "performance");
  mkdirSync(join(dir, "core.sqlite3"));
  try {
    await assert.rejects(
      startDaemon(dir, { env: { HIVE_PERF_DIR: directory } }),
      /daemon exited early/,
    );

    const artifact = readArtifacts(directory);
    const storage = spanSummary(artifact, "daemon.start.storage");
    assert.equal(requireNumber(storage.count, "storage count"), 1);
    assert.equal(requireNumber(storage.errors, "storage errors"), 1);
    const total = spanSummary(artifact, "daemon.start.total");
    assert.equal(requireNumber(total.count, "startup total count"), 1);
    assert.equal(requireNumber(total.errors, "startup total errors"), 1);
  } finally {
    cleanup();
  }
});

test("RPC profiling preserves sync ordering and async success and failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-perf-rpc-"));
  const directory = join(root, "artifacts");
  const socketPath = join(root, "rpc.sock");
  const profiler = createPerformanceProfiler({
    env: { HIVE_PERF_DIR: directory },
    log: () => undefined,
    limits: { durationMs: 60_000, sampleIntervalMs: 60_000 },
  });
  let resolveSpawn: (value: object) => void = () => undefined;
  const spawnResult = new Promise<object>((resolve) => {
    resolveSpawn = resolve;
  });
  const server = new RpcServer({
    socketPath,
    log: () => undefined,
    performance: profiler,
    dispatch: (verb) => {
      if (verb === "spawn") return spawnResult;
      if (verb === "send") return Promise.reject(new Error(SECRET_ERROR));
      return { status: "sync" };
    },
  });
  let client: RpcClient | null = null;
  try {
    profiler.start();
    await server.listen();
    client = await RpcClient.connect(socketPath);

    let asyncSettled = false;
    const pending = client
      .request("spawn", { prompt: SECRET_PARAM })
      .then((value) => {
        asyncSettled = true;
        return value;
      });
    const sync = await client.request("health");
    assert.deepEqual(sync, { status: "sync" });
    assert.equal(asyncSettled, false, "a pending async verb did not block a later sync verb");
    resolveSpawn({ status: "async" });
    assert.deepEqual(await pending, { status: "async" });
    await assert.rejects(
      client.request("send", { body: SECRET_PARAM }),
      (error: unknown) =>
        error instanceof RpcError &&
        error.code === "invalid_request" &&
        error.message === SECRET_ERROR,
    );
  } finally {
    client?.close();
    await server.close();
    profiler.stop();
  }

  try {
    const artifact = readArtifacts(directory);
    assert.equal(requireNumber(spanSummary(artifact, "rpc.spawn").count, "spawn count"), 1);
    assert.equal(requireNumber(spanSummary(artifact, "rpc.spawn").errors, "spawn errors"), 0);
    assert.equal(requireNumber(spanSummary(artifact, "rpc.health").count, "health count"), 1);
    assert.equal(requireNumber(spanSummary(artifact, "rpc.send").errors, "send errors"), 1);
    assert.ok(!artifact.traceText.includes(SECRET_PARAM));
    assert.ok(!artifact.summaryText.includes(SECRET_PARAM));
    assert.ok(!artifact.traceText.includes(SECRET_ERROR));
    assert.ok(!artifact.summaryText.includes(SECRET_ERROR));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an isolated daemon emits a usable startup, tick, RPC, and resource trace", async () => {
  const { dir, cleanup } = makeDaemonDir();
  const directory = join(dir, "performance");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, {
      env: {
        HIVE_PERF_DIR: directory,
        HIVE_PERF_DURATION_MS: "5000",
        HIVE_PERF_SAMPLE_MS: "20",
      },
    });
    const client = await daemon.client();
    assert.ok(isRecord(await client.request("health")));
    await assert.rejects(
      client.request("template.get", { id: SECRET_PARAM }),
      (error: unknown) =>
        error instanceof RpcError && error.code === "template_not_found",
    );
    await sleep(80);
    client.close();
    await daemon.stop();
    daemon = null;

    const artifact = readArtifacts(directory);
    const names = new Set(
      traceEvents(artifact).map((event) => requireString(event.name, "trace name")),
    );
    assert.ok(names.has("daemon.start.total"));
    assert.ok(names.has("daemon.tick.total"));
    assert.ok(names.has("core.step.total"));
    assert.ok(names.has("rpc.health"));
    assert.ok(names.has("rpc.template.get"));
    assert.ok(names.has("process.resources"));
    assert.equal(requireNumber(spanSummary(artifact, "rpc.health").errors, "health errors"), 0);
    assert.equal(requireNumber(spanSummary(artifact, "rpc.template.get").errors, "template errors"), 1);
    const resources = requireRecord(artifact.summary.resources, "resources");
    assert.ok(requireNumber(resources.samples, "resource samples") >= 1);
    assert.ok(requireNumber(resources.rssBytesMax, "max RSS") > 0);
    assert.ok(!artifact.traceText.includes(SECRET_PARAM));
    assert.ok(!artifact.summaryText.includes(SECRET_PARAM));
  } finally {
    await daemon?.stop().catch(() => undefined);
    cleanup();
  }
});
