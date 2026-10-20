import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runV2Cli } from "../../v2/cli/src/main.ts";
import { RpcClient } from "../../v2/cli/src/client.ts";
import { RpcError, type QuestionAskResult, type QuestionDismissResult, type SnapshotResult, type MailboxResult, type SpawnResult, type WatchFrame, type ViewResult } from "../../v2/daemon/src/protocol.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../../v2/daemon/src/localRpcTrust.ts";
import { openCoreStore, replayAudit } from "../../v2/core/src/index.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../v2/daemon/tests/helpers.ts";

const body = "Your question was dismissed without an answer.";
const options = { capabilities: ["question.dismissed.v1", "turn-trigger.answer.v1"] };
const code = (expected: string) => (error: unknown) => error instanceof RpcError && error.code === expected;

test("real disposable Honeybee: dismissal races, dedicated notice, independent readers, replay and reconnect", { timeout: 60000 }, async () => {
  const fixture = makeDaemonDir(); const keyFile = join(fixture.dir, "rpc-private", "registration.key");
  const configFile = join(fixture.dir, "config.json"); const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.rpcLocalTrust = { requireObservationCaller: true, registrationKeyFile: keyFile }; writeFileSync(configFile, JSON.stringify(config));
  const clients: RpcClient[] = []; const races: unknown[] = []; let daemon: DaemonHandle | undefined;
  const connect = async (modern = true) => { const client = await RpcClient.connect(daemon!.socketPath, 3000, undefined, modern ? options : {}); clients.push(client); return client; };
  try {
    daemon = await startDaemon(fixture.dir); let service = await connect();
    assert.ok(service.capabilities.includes("question.dismiss.v1")); assert.ok(service.capabilities.includes("question.dismissed.v1"));
    const challenge = await service.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const key = readFileSync(keyFile); const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await service.request("rpc.localTrust.register", {pid: process.pid, challengeId: challenge.challengeId, token});
    const { beeId } = await service.request<SpawnResult>("spawn", {name: "dismiss-races", agent: "inbox", cwd: fixture.dir});
    const ask = async (text: string, idempotencyKey?: string) => (await service.request<QuestionAskResult>("question.ask", {beeId, text, ...(idempotencyKey ? {idempotencyKey} : {})})).question;
    const dismiss = (questionId: string, idempotencyKey: string) => service.request<QuestionDismissResult>("question.dismiss", {questionId, idempotencyKey});
    const withdrawn = (questionId: string, idempotencyKey: string) => service.request("question.withdraw", {questionId, idempotencyKey, reason: "Superseded."}, 10000, {sessionPrincipal: {beeId}});
    const old = await connect(false), modern = await connect(); const oldFrames: WatchFrame[] = [], modernFrames: WatchFrame[] = [];
    old.onEvent = frame => oldFrames.push(frame); modern.onEvent = frame => modernFrames.push(frame); await old.request("watch"); await modern.request("watch");
    const q = await ask("Dismiss once?", "shared-key");
    const result = await dismiss(q.id, "shared-key"); assert.equal(result.question.status, "dismissed"); assert.equal(result.question.dismissedBy, "rpc");
    assert.deepEqual(await dismiss(q.id, "shared-key"), {...result, deduped: true}); assert.deepEqual(await dismiss(q.id, "new-key"), result);
    await assert.rejects(service.request("question.dismiss", {questionId: q.id, idempotencyKey: "bad-key", dismissedBy: "operator"}), code("invalid_request"));
    await assert.rejects(service.request("question.dismiss", {questionId: q.id}), code("invalid_request"));
    await assert.rejects(service.request("question.answer", {questionId: q.id, answer: "late", idempotencyKey: "late-answer"}), code("question_dismissed"));
    const next = await ask("No failed-key poison?"); assert.equal((await dismiss(next.id, "bad-key")).question.status, "dismissed");
    await assert.rejects(dismiss(next.id, "shared-key"), code("idempotency_conflict"));
    await waitFor(() => oldFrames.some(frame => frame.type === "delta" && frame.events.some(event => event.kind === "question.withdrawn" && event.payload.questionId === q.id)) && modernFrames.some(frame => frame.type === "delta" && frame.events.some(event => event.kind === "question.dismissed" && event.payload.questionId === q.id)), "both reader formats");
    const legacy = (await old.request<SnapshotResult>("snapshot")).questions.find(row => row.id === q.id)!;
    assert.equal(legacy.status, "withdrawn"); assert.equal(legacy.withdrawalReason, "Dismissed without an answer"); assert.equal(legacy.withdrawnAt, result.question.dismissedAt);
    assert.equal(Object.hasOwn(legacy, "dismissedAt"), false);
    assert.equal((await modern.request<SnapshotResult>("snapshot")).questions.find(row => row.id === q.id)!.status, "dismissed");
    const cliOutput: string[] = [];
    assert.equal(await runV2Cli(["question", "list", "--bee", beeId, "--json", "--data-dir", fixture.dir, "--socket", daemon.socketPath], {out: value => cliOutput.push(value), err: value => cliOutput.push(value)}), 0);
    assert.equal(JSON.parse(cliOutput.join("\n")).questions.find((row: {id: string}) => row.id === q.id).status, "dismissed");
    const orders = [["answer", "dismiss"], ["dismiss", "answer"], ["withdraw", "dismiss"], ["dismiss", "withdraw"], ["answer", "withdraw", "dismiss"], ["answer", "dismiss", "withdraw"], ["withdraw", "answer", "dismiss"], ["withdraw", "dismiss", "answer"], ["dismiss", "answer", "withdraw"], ["dismiss", "withdraw", "answer"]] as const;
    for (const [index, order] of orders.entries()) {
      const question = await ask(`Race ${index}?`);
      const mailBefore = (await service.request<MailboxResult>("mailbox", {beeId})).messages.length;
      const requests = order.map(verb => verb === "answer" ? service.request("question.answer", {questionId: question.id, answer: "yes", idempotencyKey: `answer-${index}`}) : verb === "withdraw" ? withdrawn(question.id, `withdraw-${index}`) : dismiss(question.id, `dismiss-${index}`));
      const outcomes = await Promise.allSettled(requests); assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
      const row = (await service.request<SnapshotResult>("snapshot")).questions.find(item => item.id === question.id)!;
      const expected = order[0] === "answer" ? "answered" : order[0] === "withdraw" ? "withdrawn" : "dismissed"; assert.equal(row.status, expected);
      const messages = (await service.request<MailboxResult>("mailbox", {beeId})).messages;
      const answerMail = messages.filter(message => message.body.startsWith(`[answer to question ${row.id}]`)), dismissalMail = messages.filter(message => message.id === row.dismissalMessageId);
      const newMailCount = messages.length - mailBefore; assert.equal(newMailCount, expected === "withdrawn" ? 0 : 1);
      assert.equal(answerMail.length, expected === "answered" ? 1 : 0); assert.equal(dismissalMail.length, expected === "dismissed" ? 1 : 0);
      assert.ok(dismissalMail.every(message => message.body === body && message.senderKind === "automation"));
      races.push({questionId: row.id, order, status: row.status, newMailCount, answerMail: answerMail.length, dismissalMail: dismissalMail.length, refusals: outcomes.flatMap(outcome => outcome.status === "rejected" ? [{code: outcome.reason.code, message: outcome.reason.message}] : [])});
    }
    service.close(); service = await connect(); assert.deepEqual(await dismiss(q.id, "shared-key"), {...result, deduped: true});
    const live = await service.request<SpawnResult>("spawn", {name: "dismiss-delivery", agent: "stub", cwd: fixture.dir});
    await waitFor(async () => (await service.request<ViewResult>("view", {beeId: live.beeId})).view.runtimeState === "idle", "stub idle");
    const liveQuestion = (await service.request<QuestionAskResult>("question.ask", {beeId: live.beeId, text: "Deliver notice?"})).question;
    const delivered = await dismiss(liveQuestion.id, "live-dismiss");
    const view = await waitFor(async () => { const value = await service.request<ViewResult>("view", {beeId: live.beeId}); assert.ok(value.bee); return value.bee.sessionLogPath && existsSync(value.bee.sessionLogPath) && readFileSync(value.bee.sessionLogPath, "utf8").includes("[Hive notice that your question was dismissed]") ? value : false; }, "dedicated envelope echoed by real stub");
    assert.ok(view.bee);
    const transcript = readFileSync(view.bee.sessionLogPath!, "utf8"); assert.ok(transcript.includes(body));
    assert.equal(view.bee.lastHumanOutputAt, null);
    const lifecycleReceipts: unknown[] = [];
    for (const transition of ["stop", "archive"] as const) {
      await service.request(transition, {beeId: live.beeId});
      await waitFor(async () => {const value = await service.request<ViewResult>("view", {beeId: live.beeId}); assert.ok(value.bee); return transition === "stop" ? value.view.runtimeState === "stopped" : value.bee.lifecycle === "archived";}, `stub ${transition}`);
      const asked = (await service.request<QuestionAskResult>("question.ask", {beeId: live.beeId, text: `${transition} notice?`})).question;
      const dismissed = await dismiss(asked.id, `lifecycle-${transition}`);
      await waitFor(async () => (await service.request<MailboxResult>("mailbox", {beeId: live.beeId})).messages.find(message => message.id === dismissed.question.dismissalMessageId)?.deliveredAt != null, `notice after ${transition}`);
      const current = await service.request<ViewResult>("view", {beeId: live.beeId});
      assert.ok(current.bee);
      assert.equal(current.bee.lifecycle, "active"); assert.equal(current.bee.lastHumanOutputAt, null);
      lifecycleReceipts.push({from: transition, questionId: asked.id, messageId: dismissed.question.dismissalMessageId, lifecycle: current.bee.lifecycle, generation: current.runtime?.generation});
    }
    await waitFor(async () => (await service.request<MailboxResult>("mailbox", {beeId: live.beeId})).messages.find(message => message.id === delivered.question.dismissalMessageId)?.deliveredAt != null, "notice committed delivery");
    clients.splice(0).forEach(client => client.close()); await daemon.stop(); assert.equal(daemon.proc.exitCode, 0, daemon.output()); assert.equal(daemon.proc.signalCode, null);
    const store = openCoreStore(daemon.storePath, {ephemeral: true});
    try {
      assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
      assert.equal(store.auditRows().filter(event => event.kind === "question.dismissed" && event.payload.questionId === q.id).length, 1);
      assert.equal(store.listMessages(beeId).filter(message => message.id === result.question.dismissalMessageId).length, 1);
      console.log(JSON.stringify({host: hostname(), data: fixture.dir, socket: daemon.socketPath, shutdown: {code: daemon.proc.exitCode, signal: daemon.proc.signalCode}, first: result.question, legacy, races, replayEqual: true, reconnectDeduped: true, dedicatedEnvelopeObserved: true, lifecycleReceipts, liveNoticeMessageId: delivered.question.dismissalMessageId, lastHumanOutputAt: view.bee.lastHumanOutputAt}));
    } finally {store.close();}
    daemon = await startDaemon(fixture.dir); service = await connect(); assert.deepEqual(await dismiss(q.id, "shared-key"), {...result, deduped: true});
    clients.splice(0).forEach(client => client.close()); await daemon.stop(); assert.equal(daemon.proc.exitCode, 0, daemon.output()); assert.equal(daemon.proc.signalCode, null);
  } finally {
    clients.forEach(client => client.close());
    if (daemon && daemon.proc.exitCode === null && daemon.proc.signalCode === null) await daemon.stop();
    fixture.cleanup();
  }
});

test("built Honeybee foreground daemon advertises dismissal and commits one neutral notice", {timeout: 30000}, async () => {
  const fixture = makeDaemonDir(); const socketPath = join(fixture.dir, "built.sock"), home = join(fixture.dir, "built-home"); mkdirSync(home);
  const proc = spawn(process.execPath, [resolve("dist/cli.js"), "v2", "daemon", "run", "--data-dir", fixture.dir, "--socket", socketPath], {env: {HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), TMPDIR: process.env.TMPDIR, PATH: process.env.PATH, HIVE_NODE_PATH: process.execPath, HIVE_GATEWAYS_DISABLE: "1", HIVE_NO_KEYCHAIN: "1"}, stdio: ["ignore", "pipe", "pipe"]});
  let output = ""; proc.stdout.on("data", chunk => output += chunk); proc.stderr.on("data", chunk => output += chunk);
  let client: RpcClient | undefined;
  try {
    client = await waitFor(async () => {if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(output); try {return await RpcClient.connect(socketPath, 500, undefined, options);} catch {return false;}}, "built daemon", 20000);
    assert.ok(client.capabilities.includes("question.dismiss.v1"));
    const {beeId} = await client.request<SpawnResult>("spawn", {name: "built-dismiss", agent: "inbox", cwd: fixture.dir});
    const asked = await client.request<QuestionAskResult>("question.ask", {beeId, text: "Built artifact?"});
    const result = await client.request<QuestionDismissResult>("question.dismiss", {questionId: asked.question.id, idempotencyKey: "built-dismiss"});
    assert.equal(result.question.status, "dismissed"); assert.equal(result.question.dismissedBy, "rpc");
    assert.deepEqual(await client.request("question.dismiss", {questionId: asked.question.id, idempotencyKey: "built-dismiss"}), {...result, deduped: true});
    const mail = (await client.request<MailboxResult>("mailbox", {beeId})).messages; assert.equal(mail.length, 1); assert.equal(mail[0]!.body, body);
    client.close(); client = undefined; const exited = once(proc, "exit"); proc.kill("SIGTERM"); const [exit, signal] = await exited;
    assert.equal(exit, 0, output); assert.equal(signal, null);
    console.log(JSON.stringify({host: hostname(), artifact: "dist/cli.js", data: fixture.dir, socket: socketPath, shutdown: {code: exit, signal}, question: result.question, notice: {id: mail[0]!.id, body: mail[0]!.body, senderKind: mail[0]!.senderKind}, stableRetry: true}));
  } finally {
    client?.close(); if (proc.exitCode === null && proc.signalCode === null) {const exited = once(proc, "exit"); proc.kill("SIGTERM"); await exited;}
    fixture.cleanup();
  }
});
