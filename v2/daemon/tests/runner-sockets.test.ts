import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
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
