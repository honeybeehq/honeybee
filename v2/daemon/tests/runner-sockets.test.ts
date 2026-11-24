import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, utimesSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import type { HealthResult, MailboxResult, SendRpcResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";

function recordedSocketPath(dataDir: string, beeId: string, generation: number): string {
  const config = JSON.parse(readFileSync(join(dataDir, "runners", `${beeId}.${generation}.json`), "utf8")) as { socketPath: string };
  return config.socketPath;
}

test("R5 runner sockets: a runtime started with its socket folder in A is adopted by a successor whose default is B, with the same pid and generation, and mail is delivered", { timeout: 120_000 }, async () => {
  const folderA = makeDaemonDir();
  const folderB = makeDaemonDir();
  const rig = makeDaemonDir({ stubEnv: { STUB_SURVIVE_STDIN_CLOSE: "1" } });
  const cache = join(realpathSync(rig.dir), "xdg-cache");
  let daemon = await startDaemon(rig.dir, { env: { XDG_CACHE_HOME: cache, TMPDIR: folderA.dir }, platform: "darwin" });
  let pid = 0;
  try {
    let client = await daemon.client();
    const { beeId } = await client.request<SpawnResult>("spawn", { name: "survivor", agent: "stub", cwd: rig.dir });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "idle", 30_000);
    pid = (await client.request<ViewResult>("view", { beeId })).runtime?.pid as number;
    const socketA = recordedSocketPath(rig.dir, beeId, 1);
    assert.ok(socketA.startsWith(realpathSync(folderA.dir)) || socketA.startsWith(folderA.dir), `the first runtime's socket is under folder A: ${socketA}`);
    client.close();
    await daemon.kill();

    daemon = await startDaemon(rig.dir, { env: { XDG_CACHE_HOME: cache, TMPDIR: folderB.dir } });
    client = await daemon.client();
    const health = await client.request<HealthResult>("health");
    assert.equal(health.lastBoot?.adopted, 1);
    const sent = await client.request<SendRpcResult>("send", { beeId, body: "after the socket folder moved" });
    await waitFor(async () => {
      const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
      return messages.find((m) => m.id === sent.messageId)?.deliveredAt != null;
    }, "post-restart delivery", 30_000);
    const rt = (await client.request<ViewResult>("view", { beeId })).runtime;
    assert.equal(rt?.generation, 1);
    assert.equal(rt?.pid, pid);
    assert.equal(readdirSync(folderB.dir).some((name) => name.startsWith("hb-rh-")), false, "nothing was created in folder B for the adopted runtime");
    client.close();
  } finally {
    await daemon.stop().catch(() => {});
    if (pid > 0) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    rig.cleanup();
    folderA.cleanup();
    folderB.cleanup();
  }
});

async function staleSocketAt(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path)}, () => console.log("listening"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function liveSocketAt(path: string): Promise<Server> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    server.listen(path, () => resolve(server));
  });
}

function age(path: string, seconds: number): void {
  const then = new Date(Date.now() - seconds * 1000);
  utimesSync(path, then, then);
}

test("R6 runner sockets: boot removes leaked empty runner folders and stale sockets, and keeps the live runner, a fresh folder and another daemon's live socket", { timeout: 120_000 }, async () => {
  const inherited = makeDaemonDir();
  const rig = makeDaemonDir({ stubEnv: { STUB_SURVIVE_STDIN_CLOSE: "1" } });
  const env = { XDG_CACHE_HOME: join(realpathSync(rig.dir), "xdg-cache"), TMPDIR: inherited.dir };
  let daemon = await startDaemon(rig.dir, { env });
  let pid = 0;
  let foreign: Server | null = null;
  try {
    let client = await daemon.client();
    const { beeId } = await client.request<SpawnResult>("spawn", { name: "live-runner", agent: "stub", cwd: rig.dir });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "idle", 30_000);
    pid = (await client.request<ViewResult>("view", { beeId })).runtime?.pid as number;
    const liveSocket = recordedSocketPath(rig.dir, beeId, 1);
    const socketFolder = dirname(dirname(liveSocket));
    client.close();
    await daemon.kill();

    const leaked: string[] = [];
    const kept: string[] = [dirname(liveSocket)];
    for (const folder of new Set([socketFolder, inherited.dir])) {
      for (const name of ["hb-rh-aaaaaaaaaaaaaaa1", "hb-rh-aaaaaaaaaaaaaaa2", "hb-rh-aaaaaaaaaaaaaaa3"]) {
        mkdirSync(join(folder, name), { mode: 0o700 });
        age(join(folder, name), 3600);
        leaked.push(join(folder, name));
      }
      const stale = join(folder, "hb-rh-bbbbbbbbbbbbbbb1", "stdin.sock");
      await staleSocketAt(stale);
      age(stale, 3600);
      age(dirname(stale), 3600);
      leaked.push(dirname(stale));
      const fresh = join(folder, "hb-rh-ccccccccccccccc1");
      mkdirSync(fresh, { mode: 0o700 });
      kept.push(fresh);
    }
    const foreignSocket = join(inherited.dir, "hb-rh-ddddddddddddddd1", "stdin.sock");
    foreign = await liveSocketAt(foreignSocket);
    age(foreignSocket, 3600);
    age(dirname(foreignSocket), 3600);
    kept.push(dirname(foreignSocket));
    for (const path of [...leaked, ...kept]) assert.ok(existsSync(path), `planted ${path}`);

    const sweepLines = () => readFileSync(join(rig.dir, "hived.log"), "utf8").split("\n").filter((line) => line.includes("runner.sockets.swept")).length;
    const sweepsBefore = sweepLines();
    daemon = await startDaemon(rig.dir, { env });
    client = await daemon.client();
    await waitFor(() => sweepLines() > sweepsBefore, "boot sweep logged", 10_000).catch(() => undefined);
    for (const path of leaked) assert.equal(existsSync(path), false, `removed ${path}`);
    for (const path of kept) assert.equal(existsSync(path), true, `kept ${path}`);
    const sent = await client.request<SendRpcResult>("send", { beeId, body: "the live runner still hears the daemon" });
    await waitFor(async () => {
      const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
      return messages.find((m) => m.id === sent.messageId)?.deliveredAt != null;
    }, "delivery after the sweep", 30_000);
    client.close();
  } finally {
    foreign?.close();
    await daemon.stop().catch(() => {});
    if (pid > 0) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    rig.cleanup();
    inherited.cleanup();
  }
});
