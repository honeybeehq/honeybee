import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { openCoreStore, replayAudit } from "../../v2/core/src/index.ts";
import { RpcClient } from "../../v2/cli/src/client.ts";
import { runV2Cli } from "../../v2/cli/src/main.ts";
import type { QuestionAnswerResult, QuestionAskResult, MailboxResult, SpawnResult, ViewResult } from "../../v2/daemon/src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../v2/daemon/tests/helpers.ts";

test("real disposable daemon: RPC attribution, CLI label, reconnect and one effect per receipt", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | undefined;
  try {
    daemon = await startDaemon(dir);
    const connectModern = () => RpcClient.connect(daemon!.socketPath, 3000, undefined, { capabilities: ["turn-trigger.answer.v1"] });
    let client = await connectModern();
    const { beeId } = await client.request<SpawnResult>("spawn", { name: "lab-asker", agent: "stub", cwd: dir });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "lab bee idle");
    const asked = await client.request<QuestionAskResult>("question.ask", { beeId, text: "synthetic attribution check?" });
    const answered = await client.request<QuestionAnswerResult>("question.answer", { questionId: asked.question.id, answer: "yes", answeredBy: "operator", idempotencyKey: "lab-answer" });
    assert.equal(answered.question.answeredBy, "rpc");
    client.close();
    client = await connectModern();
    const retry = await client.request<QuestionAnswerResult>("question.answer", { questionId: asked.question.id, answer: "ignored replay", answeredBy: { role: "human" }, idempotencyKey: "lab-answer" });
    assert.equal(retry.deduped, true);
    assert.equal(retry.messageId, answered.messageId);
    assert.equal(retry.question.answeredBy, "rpc");
    await waitFor(async () => {
      const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
      return messages.find((m) => m.id === answered.messageId)?.deliveredAt != null;
    }, "answer delivered");
    await waitFor(async () => {
      const { bee } = await client.request<ViewResult>("view", { beeId });
      return bee.lastTurnTrigger?.kind === "answer" && bee.lastHumanOutputAt !== null;
    }, "answer bookkeeping");
    const legacy = await daemon.client();
    const legacyView = await legacy.request<ViewResult>("view", { beeId });
    const modernView = await client.request<ViewResult>("view", { beeId });
    legacy.close();
    assert.equal(legacyView.bee!.lastTurnTrigger!.kind, "human");
    assert.equal(modernView.bee!.lastTurnTrigger!.kind, "answer");
    assert.equal(legacyView.bee!.lastHumanOutputAt, modernView.bee!.lastHumanOutputAt);
    assert.deepEqual(legacyView.bee!.lastTurnTrigger, { ...modernView.bee!.lastTurnTrigger, kind: "human" });
    const second = await client.request<QuestionAskResult>("question.ask", { beeId, text: "CLI local label?" });
    const display: string[] = [];
    assert.equal(await runV2Cli(["answer", second.question.id, "yes", "--by", "local-only", "--data-dir", dir, "--socket", daemon.socketPath], { out: (s) => display.push(s), err: (s) => display.push(s) }), 0);
    assert.match(display.join("\n"), /display label: "local-only"/);
    client.close();
    await daemon.stop();
    assert.equal(daemon.proc.exitCode, 0, daemon.output());
    assert.equal(daemon.proc.signalCode, null);
    const store = openCoreStore(daemon.storePath, { ephemeral: true });
    try {
      const rows = store.listQuestions({ beeId });
      const mail = store.listMessages(beeId);
      const events = store.auditRows().filter((r) => r.kind === "question.answered");
      assert.equal(rows.length, 2);
      assert.equal(events.length, 2);
      assert.ok(rows.every((q) => q.answeredBy === "rpc"));
      assert.ok(events.every((e) => e.payload.answeredBy === "rpc"));
      assert.ok(rows.every((q) => mail.filter((m) => m.id === q.deliveryMessageId && m.sender === "rpc").length === 1));
      assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
      console.log(JSON.stringify({ host: hostname(), data: dir, socket: daemon.socketPath, shutdown: { code: daemon.proc.exitCode, signal: daemon.proc.signalCode }, reconnectDeduped: retry.deduped, subscriberFormats: { legacy: legacyView.bee!.lastTurnTrigger, modern: modernView.bee!.lastTurnTrigger }, questions: rows.map((q) => ({ id: q.id, status: q.status, answeredBy: q.answeredBy, deliveryMessageId: q.deliveryMessageId })), answerEventCount: events.length, answerMailCount: rows.filter((q) => mail.some((m) => m.id === q.deliveryMessageId)).length, trigger: store.getBee(beeId)!.lastTurnTrigger, replayEqual: true, cliDisplay: display }));
    } finally {
      store.close();
    }
  } finally {
    if (daemon && daemon.proc.exitCode === null && daemon.proc.signalCode === null) await daemon.stop();
    cleanup();
  }
});
