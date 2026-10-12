import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageRow } from "../../core/src/index.ts";
import { runV2Cli } from "../../cli/src/main.ts";
import { loadNodeConfig } from "../src/config.ts";
import { HiveDaemon, type MailboxOnlyForwarder } from "../src/daemon.ts";
import { RpcClient } from "../../cli/src/client.ts";
import type { AuditTailResult, CommandsResult, MailboxResult, SendRpcResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, sleep, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const AMBIENT = ["HIVE_BEE_ID", "HIVE_BEE", "HIVE_V2_DATA_DIR", "HIVE_CELL", "HIVE_CELL_SPACE"] as const;

async function cli(daemon: DaemonHandle, args: string[]): Promise<{ exit: number; out: string; err: string }> {
  const saved = Object.fromEntries(AMBIENT.map((key) => [key, process.env[key]]));
  for (const key of AMBIENT) delete process.env[key];
  const out: string[] = [];
  const err: string[] = [];
  try {
    const exit = await runV2Cli([...args, "--socket", daemon.socketPath, "--data-dir", daemon.dir], { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { exit, out: out.join("\n"), err: err.join("\n") };
  } finally {
    for (const key of AMBIENT) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
}

test("inbox bee: spawn, send, poll, ack, events, wait, and daemon restart through the real daemon and CLI", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    let client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "grokbot", agent: "inbox", cwd: "/tmp" });
    assert.equal(spawned.agent, "inbox");
    assert.equal(spawned.commandId, null);
    assert.equal(spawned.account, null);
    const beeId = spawned.beeId;

    const sent = await cli(daemon, ["send", "grokbot", "hello from operator", "--json"]);
    assert.equal(sent.exit, 0, sent.err);
    const second = await client.request<SendRpcResult>("send", { beeId, body: "second", sender: "human:tormod" });
    assert.equal(second.commandId, null);

    const all = await cli(daemon, ["mailbox", "grokbot", "--json"]);
    assert.equal(all.exit, 0, all.err);
    const messages = (JSON.parse(all.out) as MailboxResult).messages;
    assert.deepEqual(messages.map((m) => m.body), ["hello from operator", "second"]);
    assert.equal(messages[1]!.sender, "human:tormod");
    const [first, last] = messages as [MessageRow, MessageRow];

    const since = await cli(daemon, ["mailbox", "grokbot", "--json", "--since", String(first.id)]);
    assert.deepEqual((JSON.parse(since.out) as MailboxResult).messages.map((m) => m.id), [last.id]);

    const acked = await cli(daemon, ["ack", "grokbot", String(first.id), "--json"]);
    assert.equal(acked.exit, 0, acked.err);
    assert.deepEqual(JSON.parse(acked.out).acked, [first.id]);
    const unread = await client.request<MailboxResult>("mailbox", { beeId, unread: true });
    assert.deepEqual(unread.messages.map((m) => m.id), [last.id]);

    const events = await cli(daemon, ["events", "--bee", "grokbot", "--kind", "mail.*", "--json"]);
    assert.equal(events.exit, 0, events.err);
    assert.match(events.out, /mail\.enqueued/);
    assert.match(events.out, /mail\.delivered/);

    const waited = await cli(daemon, ["wait", "grokbot", "--timeout", "2000", "--json"]);
    assert.equal(waited.exit, 0, waited.err);

    const revive = await client.request("revive", { beeId }).then(() => null, (err: Error) => err);
    assert.match(String(revive), /mailbox-only/);
    const run = await cli(daemon, ["run", "inbox-run", "-p", "hi", "--agent", "inbox"]);
    assert.equal(run.exit, 1);
    assert.match(run.err, /mailbox-only/);

    await sleep(200);
    assert.deepEqual((await client.request<CommandsResult>("commands", { beeId })).commands, []);
    client.close();

    await daemon.kill();
    daemon = await startDaemon(dir);
    client = await daemon.client();
    await sleep(200);
    const { view, runtime } = await client.request<ViewResult>("view", { beeId });
    assert.equal(runtime?.generation, 1);
    assert.equal(runtime?.state, "stopped");
    assert.equal(runtime?.exitCause, "clean");
    assert.equal(view.blocked, false);
    assert.equal(view.working, false);
    assert.deepEqual((await client.request<CommandsResult>("commands", { beeId })).commands, []);
    assert.deepEqual((await client.request<MailboxResult>("mailbox", { beeId, unread: true })).messages.map((m) => m.id), [last.id]);
    const ackAll = await client.request<{ acked: number[] }>("mail.ack", { beeId, all: true });
    assert.deepEqual(ackAll.acked, [last.id]);
    const tail = await client.request<AuditTailResult>("audit.tail", { beeId, limit: 1000 });
    assert.ok(!tail.rows.some((row) => row.kind === "command.enqueued"));
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("inbox bee: spawn refuses runtime-only options", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    for (const extra of [{ substrate: "cell" }, { account: "some-account" }, { args: ["--model", "x"] }]) {
      const err = await client.request("spawn", { name: "nope", agent: "inbox", cwd: "/tmp", ...extra }).then(() => null, (e: Error) => e);
      assert.match(String(err), /mailbox-only/, JSON.stringify(extra));
    }
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("inbox bee: `stub` aliases inbox only when no agent named stub is configured", async () => {
  const { dir, cleanup } = makeDaemonDir();
  const configPath = join(dir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  delete config.agents.stub;
  writeFileSync(configPath, JSON.stringify(config));
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "grokbot", agent: "stub", cwd: "/tmp" });
    assert.equal(spawned.agent, "inbox");
    assert.equal(spawned.commandId, null);
    const { bee } = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    assert.equal(bee?.agent, "inbox");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("inbox bee: the outbox forwarder hook sees committed mail and its failure never rejects the send", async () => {
  const { dir, cleanup } = makeDaemonDir();
  const savedKeychain = process.env.HIVE_NO_KEYCHAIN;
  process.env.HIVE_NO_KEYCHAIN = "1";
  const forwarded: Array<{ beeId: string; body: string }> = [];
  const forward: MailboxOnlyForwarder = ({ bee, message }) => {
    forwarded.push({ beeId: bee.id, body: message.body });
    throw new Error("webhook down");
  };
  const cfg = loadNodeConfig(dir);
  const daemon = new HiveDaemon(cfg, { forwardMailboxOnlyMail: forward });
  try {
    await daemon.start();
    const client = await RpcClient.connect(cfg.socketPath);
    const inbox = await client.request<SpawnResult>("spawn", { name: "grokbot", agent: "inbox", cwd: "/tmp" });
    const sent = await client.request<SendRpcResult>("send", { beeId: inbox.beeId, body: "ping" });
    assert.ok(sent.messageId > 0);
    await waitFor(() => forwarded.length === 1, "forwarder called", 2000);
    assert.deepEqual(forwarded, [{ beeId: inbox.beeId, body: "ping" }]);
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId: inbox.beeId });
    assert.equal(messages.length, 1);
    client.close();
  } finally {
    await daemon.shutdown().catch(() => {});
    if (savedKeychain === undefined) delete process.env.HIVE_NO_KEYCHAIN; else process.env.HIVE_NO_KEYCHAIN = savedKeychain;
    cleanup();
  }
});
