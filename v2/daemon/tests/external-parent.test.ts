/**
 * Bounded external-parent RPC contract. Every daemon and runtime in this file
 * uses a disposable temp directory and the stub harness.
 */
import { createConnection } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { beeIdentityEnv } from "../src/daemon.ts";
import {
  RpcError,
  type CommandsResult,
  type DeployInfoResult,
  type HelloFrame,
  type ListResult,
  type MailboxResult,
  type MutationResult,
  type SnapshotResult,
  type SpawnResult,
  type ViewResult,
  type WatchFrame,
} from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const EXTERNAL_PARENT_ID = "15ecdadc-f4b1-4265-9fac-9516a5ada650";
const LOCAL_PARENT_ID = "named-parent";

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof RpcError && error.code === code);
}

function readHello(socketPath: string): Promise<HelloFrame> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for daemon hello"));
    }, 3_000);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as HelloFrame);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("spawn external-parent validation, mirroring, replay, restart, and delete policy", { timeout: 45_000 }, async () => {
  const rig = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    let client = await daemon.client();

    const hello = await readHello(daemon.socketPath);
    assert.ok(hello.capabilities.includes("spawn.external_parent.v1"));
    const deployInfo = await client.request<DeployInfoResult>("deployInfo");
    assert.ok(deployInfo.capabilities.includes("spawn.external_parent.v1"));

    await rejectsCode(client.request("spawn", {
      name: "missing-parent",
      agent: "stub",
      cwd: "/tmp",
      parentExternal: true,
    }), "invalid_request");
    await rejectsCode(client.request("spawn", {
      name: "nonboolean",
      agent: "stub",
      cwd: "/tmp",
      parentId: EXTERNAL_PARENT_ID,
      parentExternal: "true",
    }), "invalid_request");
    await rejectsCode(client.request("spawn", {
      name: "empty-parent",
      agent: "stub",
      cwd: "/tmp",
      parentId: "",
      parentExternal: true,
    }), "invalid_request");
    await rejectsCode(client.request("spawn", {
      name: "malformed-parent",
      agent: "stub",
      cwd: "/tmp",
      parentId: "\ud800",
      parentExternal: true,
    }), "invalid_request");
    await rejectsCode(client.request("spawn", {
      name: "oversized-parent",
      agent: "stub",
      cwd: "/tmp",
      parentId: "x".repeat(257),
      parentExternal: true,
    }), "invalid_request");
    await rejectsCode(client.request("spawn", {
      name: "ordinary-orphan",
      agent: "stub",
      cwd: "/tmp",
      parentId: EXTERNAL_PARENT_ID,
    }), "bee_not_found");
    await rejectsCode(client.request("spawn", {
      name: "false-orphan",
      agent: "stub",
      cwd: "/tmp",
      parentId: EXTERNAL_PARENT_ID,
      parentExternal: false,
    }), "bee_not_found");

    const watcher = await daemon.client();
    const frames: WatchFrame[] = [];
    watcher.onEvent = (frame: WatchFrame) => frames.push(frame);
    await watcher.request<SnapshotResult>("watch");

    const first = await client.request<SpawnResult>("spawn", {
      name: "remote-child",
      agent: "stub",
      cwd: "/tmp",
      parentId: EXTERNAL_PARENT_ID,
      parentExternal: true,
      prompt: "one transactional prompt",
      idempotencyKey: "external-parent-spawn-1",
    });
    const replay = await client.request<SpawnResult>("spawn", {
      name: "ignored-on-replay",
      agent: "stub",
      cwd: "/tmp",
      parentId: EXTERNAL_PARENT_ID,
      parentExternal: false,
      prompt: "one transactional prompt",
      idempotencyKey: "external-parent-spawn-1",
    });
    assert.equal(replay.deduped, true);
    assert.equal(replay.beeId, first.beeId);
    assert.equal(replay.commandId, first.commandId);
    assert.equal(replay.messageId, first.messageId);

    const view = await client.request<ViewResult>("view", { beeId: first.beeId });
    assert.equal(view.bee?.parentId, EXTERNAL_PARENT_ID);
    assert.equal(view.bee?.parentExternal, true, "replay cannot replace the original lineage claim");
    assert.ok(view.bee);
    assert.equal(beeIdentityEnv(view.bee).HIVE_PARENT, EXTERNAL_PARENT_ID,
      "HIVE_PARENT remains the bare Bee ID");

    const snapshot = await client.request<SnapshotResult>("snapshot");
    assert.equal(snapshot.views.find((candidate) => candidate.bee?.id === first.beeId)?.bee?.parentExternal, true);
    const created = await waitFor(() => {
      for (const frame of frames) {
        if (frame.type !== "delta") continue;
        const event = frame.events.find((candidate) => candidate.kind === "bee.created" && candidate.beeId === first.beeId);
        if (event) return event;
      }
      return null;
    }, "external child creation delta");
    assert.equal((created.payload.bee as { parentExternal?: unknown }).parentExternal, true);

    const mailbox = await client.request<MailboxResult>("mailbox", { beeId: first.beeId });
    assert.equal(mailbox.messages.filter((message) => message.body === "one transactional prompt").length, 1);
    const commands = await client.request<CommandsResult>("commands", { beeId: first.beeId });
    assert.equal(commands.commands.filter((command) => command.verb === "spawn").length, 1);

    watcher.close();
    client.close();
    await daemon.stop();
    daemon = await startDaemon(rig.dir);
    client = await daemon.client();

    const restarted = await client.request<ViewResult>("view", { beeId: first.beeId });
    assert.equal(restarted.bee?.parentId, EXTERNAL_PARENT_ID);
    assert.equal(restarted.bee?.parentExternal, true);
    const restartedSnapshot = await client.request<SnapshotResult>("snapshot");
    assert.equal(
      restartedSnapshot.views.find((candidate) => candidate.bee?.id === first.beeId)?.bee?.parentExternal,
      true,
    );
    const restartedReplay = await client.request<SpawnResult>("spawn", {
      name: "still-ignored",
      agent: "stub",
      cwd: "/tmp",
      parentId: EXTERNAL_PARENT_ID,
      parentExternal: false,
      idempotencyKey: "external-parent-spawn-1",
    });
    assert.equal(restartedReplay.beeId, first.beeId);
    assert.equal(restartedReplay.deduped, true);
    assert.equal((await client.request<ViewResult>("view", { beeId: first.beeId })).bee?.parentExternal, true);

    const localParent = await client.request<SpawnResult>("spawn", {
      id: LOCAL_PARENT_ID,
      name: "local-parent",
      agent: "stub",
      cwd: "/tmp",
    });
    const localChild = await client.request<SpawnResult>("spawn", {
      name: "local-child",
      agent: "stub",
      cwd: "/tmp",
      parentId: localParent.beeId,
    });
    const externalCollision = await client.request<SpawnResult>("spawn", {
      name: "external-collision",
      agent: "stub",
      cwd: "/tmp",
      parentId: localParent.beeId,
      parentExternal: true,
    });
    assert.equal(
      (await client.request<ViewResult>("view", { beeId: externalCollision.beeId })).bee?.parentExternal,
      true,
      "a locally present non-UUID Bee ID may still be stored as an external claim",
    );

    const deleted = await client.request<MutationResult>("delete", { beeId: localParent.beeId });
    assert.equal(typeof deleted.commandId, "number");
    await waitFor(async () => {
      const candidate = await client.request<ViewResult>("view", { beeId: localParent.beeId });
      return candidate.view.exists ? null : true;
    }, "local parent deletion");
    const localAfterDelete = await client.request<ViewResult>("view", { beeId: localChild.beeId });
    assert.equal(localAfterDelete.bee?.parentId, null);
    assert.equal(localAfterDelete.bee?.parentExternal, false);
    const externalAfterDelete = await client.request<ViewResult>("view", { beeId: externalCollision.beeId });
    assert.equal(externalAfterDelete.bee?.parentId, LOCAL_PARENT_ID);
    assert.equal(externalAfterDelete.bee?.parentExternal, true);

    const listed = await client.request<ListResult>("list");
    assert.equal(listed.views.filter((candidate) => candidate.bee?.id === first.beeId).length, 1,
      "idempotent replay leaves one child");
    client.close();
  } finally {
    await daemon?.stop().catch(() => undefined);
    rig.cleanup();
  }
});
