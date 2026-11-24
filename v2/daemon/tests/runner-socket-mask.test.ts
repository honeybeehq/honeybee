import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CellExecResult, HealthResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { socketPathFits } from "../src/socketPath.ts";
import { makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { AGENT_PATH, makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "socket-probe", "probe.mjs");
const SANDBOX_PRIVATE = ["/tmp/", "/var/tmp/", "/dev/shm/"];

function repositoryCacheBase(): { base: string } | { skip: string } {
  const cache = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".cache");
  mkdirSync(cache, { recursive: true });
  const base = realpathSync(cache);
  if (SANDBOX_PRIVATE.some((prefix) => `${base}/`.startsWith(prefix))) return { skip: `the repository's .cache (${base}) is inside a sandbox-private mount` };
  const probe = join(base, "hb-v2-daemon-XXXXXX", "l", `hb-rh-${"0".repeat(16)}`, "stdin.sock");
  if (!socketPathFits(probe)) return { skip: `the repository's .cache is too deep for a unix socket path (${probe})` };
  return { base };
}

async function waitIdle(client: Awaited<ReturnType<Awaited<ReturnType<typeof startDaemon>>["client"]>>, beeId: string): Promise<ViewResult> {
  await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", `${beeId} idle`, 60_000);
  return client.request<ViewResult>("view", { beeId });
}

async function probeFromInside(space: string, targets: string[]): Promise<Record<string, string>> {
  writeFileSync(join(space, ".socket-probe-targets.json"), JSON.stringify(targets));
  const resultsPath = join(space, ".socket-probe-results.json");
  await waitFor(() => existsSync(resultsPath), "probe results from inside the sandbox", 30_000);
  return JSON.parse(readFileSync(resultsPath, "utf8")) as Record<string, string>;
}

const PROBE_AGENT = {
  probe: {
    command: process.execPath,
    args: ["--import", PROBE, AGENT_PATH],
    adapter: "stub",
    env: { STUB_TURN_MS: "10", STUB_SURVIVE_STDIN_CLOSE: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  },
};
const BWRAP = process.platform === "linux" && spawnSync("bwrap", ["--version"]).status === 0;

function recordedSocketPath(dataDir: string, beeId: string): string {
  return (JSON.parse(readFileSync(join(dataDir, "runners", `${beeId}.1.json`), "utf8")) as { socketPath: string }).socketPath;
}

function connectsFromOutside(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

test("D7 guard: a process inside a sandboxed Cell bee cannot reach its own runner socket or another bee's", { timeout: 180_000, skip: BWRAP ? false : "needs Linux with bwrap" }, async (t) => {
  const placed = repositoryCacheBase();
  if ("skip" in placed) {
    t.skip(placed.skip);
    return;
  }
  const { base } = placed;
  const rig = makeDaemonDir({
    nodeKind: "satellite",
    agents: {
      probe: {
        command: process.execPath,
        args: ["--import", PROBE, AGENT_PATH],
        adapter: "stub",
        env: { STUB_TURN_MS: "10", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      },
    },
  }, { base });
  const origin = makeOrigin(rig.dir);
  const daemon = await startDaemon(rig.dir, { env: { XDG_CACHE_HOME: join(realpathSync(rig.dir), "xdg-cache") }, platform: process.platform });
  try {
    const client = await daemon.client();
    const spawn = (name: string) => client.request<SpawnResult>("spawn", { name, agent: "probe", cwd: "/ignored", substrate: "cell", cell: { originRepo: origin.repo, sandbox: true } });
    const own = await spawn("mask-probe-own");
    const other = await spawn("mask-probe-other");
    for (const { beeId } of [own, other]) {
      await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", `${beeId} idle`, 60_000);
    }
    const ownSocket = recordedSocketPath(rig.dir, own.beeId);
    const otherSocket = recordedSocketPath(rig.dir, other.beeId);
    for (const path of [ownSocket, otherSocket]) {
      assert.ok(path.startsWith(join(rig.dir, "run") + "/"), `runner socket under <dataDir>/run: ${path}`);
      assert.ok(!SANDBOX_PRIVATE.some((prefix) => realpathSync(path).startsWith(prefix)), `the socket is outside every sandbox-private mount, as ~/.hive/v2 is: ${path}`);
      assert.equal(await connectsFromOutside(path), true, `the socket is live from outside the sandbox: ${path}`);
    }
    const space = (await client.request<ViewResult>("view", { beeId: own.beeId })).bee?.cwd as string;
    writeFileSync(join(space, ".socket-probe-targets.json"), JSON.stringify([ownSocket, otherSocket]));
    const resultsPath = join(space, ".socket-probe-results.json");
    await waitFor(() => existsSync(resultsPath), "probe results from inside the sandbox", 30_000);
    const results = JSON.parse(readFileSync(resultsPath, "utf8")) as Record<string, string>;
    const reached = { ownRunnerSocket: results[ownSocket], otherBeesRunnerSocket: results[otherSocket] };
    assert.deepEqual({ ownRunnerSocket: reached.ownRunnerSocket === "connected", otherBeesRunnerSocket: reached.otherBeesRunnerSocket === "connected" }, { ownRunnerSocket: false, otherBeesRunnerSocket: false }, `connect results inside the sandbox: ${JSON.stringify(reached)}`);
    client.close();
  } finally {
    await daemon.stop().catch(() => {});
    rig.cleanup();
  }
});

test("D7 guard: a deleted runner socket folder never stops a sandboxed start or a cell exec", { timeout: 180_000, skip: BWRAP ? false : "needs Linux with bwrap" }, async (t) => {
  const placed = repositoryCacheBase();
  if ("skip" in placed) {
    t.skip(placed.skip);
    return;
  }
  const rig = makeDaemonDir({ nodeKind: "satellite", agents: PROBE_AGENT }, { base: placed.base });
  const origin = makeOrigin(rig.dir);
  const daemon = await startDaemon(rig.dir, { env: { XDG_CACHE_HOME: join(realpathSync(rig.dir), "xdg-cache") }, platform: process.platform });
  try {
    const client = await daemon.client();
    const spawn = (name: string) => client.request<SpawnResult>("spawn", { name, agent: "probe", cwd: "/ignored", substrate: "cell", cell: { originRepo: origin.repo, sandbox: true } });
    const first = await spawn("mask-folder-first");
    const view = await waitIdle(client, first.beeId);
    await client.request("stop", { beeId: first.beeId });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: first.beeId })).view.runtimeState === "stopped", "first stopped", 30_000);
    const runDir = join(rig.dir, "run");
    rmSync(runDir, { recursive: true, force: true });
    const exec = await client.request<CellExecResult>("cell.exec", { cellId: view.cell!.id, idempotencyKey: "exec-after-run-removed", argv: [process.execPath, "-e", "console.log('exec ok')"] });
    assert.equal(exec.status, "done", `cell exec after the runner socket folder was removed: ${JSON.stringify(exec)}`);
    assert.equal(exec.exitCode, 0, `cell exec after the runner socket folder was removed exited ${exec.exitCode}: ${exec.stderr.trim()}`);
    assert.equal(exec.stdout.trim(), "exec ok");
    rmSync(runDir, { recursive: true, force: true });
    const second = await spawn("mask-folder-second");
    const started = await waitIdle(client, second.beeId);
    assert.equal(started.bee?.spawnFailures, 0, "the sandboxed start after the folder was removed booted first time");
    assert.ok(existsSync(runDir), "the runner socket folder exists again");
    client.close();
  } finally {
    await daemon.stop().catch(() => {});
    rig.cleanup();
  }
});

test("D7 guard: a runner that survived the upgrade with its socket outside run/ and outside /tmp is hidden from sandboxed bees", { timeout: 180_000, skip: BWRAP ? false : "needs Linux with bwrap" }, async (t) => {
  const placed = repositoryCacheBase();
  if ("skip" in placed) {
    t.skip(placed.skip);
    return;
  }
  const rig = makeDaemonDir({ nodeKind: "satellite", agents: PROBE_AGENT, stubEnv: { STUB_SURVIVE_STDIN_CLOSE: "1" } }, { base: placed.base });
  const legacy = join(rig.dir, "l");
  mkdirSync(legacy);
  const origin = makeOrigin(rig.dir);
  const cache = join(realpathSync(rig.dir), "xdg-cache");
  let daemon = await startDaemon(rig.dir, { env: { XDG_CACHE_HOME: cache, TMPDIR: legacy }, platform: "darwin" });
  let survivorPid = 0;
  try {
    let client = await daemon.client();
    const survivor = await client.request<SpawnResult>("spawn", { name: "legacy-survivor", agent: "stub", cwd: rig.dir });
    survivorPid = (await waitIdle(client, survivor.beeId)).runtime?.pid as number;
    const survivorSocket = recordedSocketPath(rig.dir, survivor.beeId);
    assert.ok(survivorSocket.startsWith(`${legacy}/`), `the survivor's socket is in the old layout: ${survivorSocket}`);
    client.close();
    await daemon.kill();

    daemon = await startDaemon(rig.dir, { env: { XDG_CACHE_HOME: cache }, platform: process.platform });
    client = await daemon.client();
    assert.equal((await client.request<HealthResult>("health")).lastBoot?.adopted, 1);
    assert.equal(recordedSocketPath(rig.dir, survivor.beeId), survivorSocket);
    assert.equal(await connectsFromOutside(survivorSocket), true, "the survivor's socket is live from outside");
    const probe = await client.request<SpawnResult>("spawn", { name: "legacy-probe", agent: "probe", cwd: "/ignored", substrate: "cell", cell: { originRepo: origin.repo, sandbox: true } });
    const space = (await waitIdle(client, probe.beeId)).bee?.cwd as string;
    const results = await probeFromInside(space, [survivorSocket]);
    assert.notEqual(results[survivorSocket], "connected", `inside the sandbox, the survivor's socket: ${results[survivorSocket]}`);
    client.close();
  } finally {
    await daemon.stop().catch(() => {});
    if (survivorPid > 0) {
      try { process.kill(-survivorPid, "SIGKILL"); } catch {}
      try { process.kill(survivorPid, "SIGKILL"); } catch {}
    }
    rig.cleanup();
  }
});
