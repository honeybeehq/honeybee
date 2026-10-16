import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient } from "../../v2/cli/src/client.ts";
import { RpcError, type QuestionAskResult, type QuestionWithdrawResult, type QuestionAnswerResult, type SnapshotResult, type MailboxResult, type SpawnResult, type WatchFrame } from "../../v2/daemon/src/protocol.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../../v2/daemon/src/localRpcTrust.ts";
import { openCoreStore, replayAudit } from "../../v2/core/src/index.ts";

const evidence = resolve(process.argv[2] ?? ".proof/T15h-honeybee-withdraw");
mkdirSync(evidence, { recursive: true });
const base = join(homedir(), ".cache", "T15h-honeybee-withdraw");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "lab-"));
const data = join(root, "data"); mkdirSync(data, { mode: 0o700 });
const socket = join(root, "rpc.sock");
const keyFile = join(data, "rpc-private", "registration.key");
const receipts: unknown[] = [{ host: hostname(), root, data, socket, nodePath: process.execPath, env: "env -i HOME=$HOME PATH=$PATH", runtime: resolve("dist/cli.js") }];
let daemon: ChildProcess | undefined;
const clients: RpcClient[] = [];
const config = (enabled: boolean) => writeFileSync(join(data, "config.json"), JSON.stringify({
  tickMs: 20, idleWindowMs: 0, naming: { auto: false },
  accounts: { vaultDir: join(data, "vault"), homesDir: join(data, "homes"), limitsRefreshMs: 0 },
  rpcLocalTrust: { requireObservationCaller: enabled, registrationKeyFile: keyFile },
}));
async function connect(lane?: "remote" | "node_relay") {
  const c = await RpcClient.connect(socket, 500, lane); clients.push(c); return c;
}
async function start() {
  daemon = spawn("env", ["-i", `HOME=${process.env.HOME}`, `PATH=${process.env.PATH}`, `HIVE_NODE_PATH=${process.execPath}`, process.execPath, resolve("dist/cli.js"), "v2", "daemon", "run", "--data-dir", data, "--socket", socket], { stdio: ["ignore", "pipe", "pipe"] });
  const child = daemon;
  let output = "";
  daemon.stdout!.on("data", c => { output += c; }); daemon.stderr!.on("data", c => { output += c; });
  daemon.once("exit", () => writeFileSync(join(evidence, `daemon-${child.pid}.log`), output));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error(output);
    try { return await connect(); } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error(`daemon timeout: ${output}`);
}
async function stop() {
  clients.splice(0).forEach(c => c.close());
  if (!daemon) return;
  const child = daemon;
  daemon = undefined;
  let code = child.exitCode;
  let signal = child.signalCode;
  if (code === null && signal === null) {
    const exited = once(child, "exit"); child.kill("SIGTERM");
    [code, signal] = await exited;
  }
  receipts.push({ shutdown: { pid: child.pid, code, signal } });
  assert.equal(signal, null, "daemon shutdown must not die from a signal");
  assert.equal(code, 0, "daemon shutdown must exit cleanly");
}

async function register(c: RpcClient) {
  const challenge = await c.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  assert.equal(challenge.pid, process.pid);
  const key = readFileSync(keyFile);
  const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
  const receipt = await c.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
  receipts.push({ registration: receipt });
}
async function refused(p: Promise<unknown>, code: string, message?: string) {
  try { await p; assert.fail(`expected ${code}`); } catch (e) {
    assert.ok(e instanceof RpcError); assert.equal(e.code, code); if (message) assert.equal(e.message, message);
    receipts.push({ refusal: e.code, message: e.message, details: e.details });
  }
}
try {
  config(false);
  let service = await start();
  assert.ok(!service.capabilities.includes("question.withdraw.v1"));
  await refused(service.request("question.withdraw"), "question_withdraw_unsupported");
  await stop(); config(true); service = await start();
  assert.ok(service.capabilities.includes("question.withdraw.v1"));
  const swapBefore = await service.request<{ schemaVersion: number; storageSupported: boolean }>("update.apiarySwap.status");
  assert.equal(swapBefore.schemaVersion, 44);
  assert.equal(swapBefore.storageSupported, true);
  receipts.push({ apiarySwapBefore: swapBefore });
  const { beeId } = await service.request<SpawnResult>("spawn", { name: "asker", agent: "inbox", cwd: root });
  const { beeId: other } = await service.request<SpawnResult>("spawn", { name: "other", agent: "inbox", cwd: root });
  const context = { sessionPrincipal: { beeId } };
  const withdraw = (id: string, key: string, reason = "Superseded.", caller = beeId) => service.request<QuestionWithdrawResult>("question.withdraw", { questionId: id, reason, idempotencyKey: key }, 10000, { sessionPrincipal: { beeId: caller } });
  const ask = async (text: string) => (await service.request<QuestionAskResult>("question.ask", { beeId, text })).question;
  const q = await ask("Withdraw this?");
  await refused(withdraw(q.id, "first"), "caller_not_trusted");
  await register(service);
  const human = await connect();
  const watcher = await connect(); const frames: WatchFrame[] = [];
  watcher.onEvent = frame => frames.push(frame);
  await watcher.request("watch");
  await refused(service.request("question.withdraw", { questionId: q.id, reason: "forged", beeId, idempotencyKey: "forged" }), "caller_not_trusted");
  for (const lane of ["remote", "node_relay"] as const) {
    const relayed = await connect(lane);
    await refused(relayed.request("question.withdraw", { questionId: q.id, reason: "forged", idempotencyKey: lane }, 1000, context), "caller_not_trusted");
  }
  await refused(withdraw(q.id, "first", "other", other), "question_not_owner");
  await refused(withdraw("missing", "missing"), "question_not_found");
  for (const reason of ["", " \n ", "x".repeat(501)]) await refused(withdraw(q.id, "bad", reason), "invalid_request");
  await refused(service.request("question.withdraw", { questionId: q.id, reason: "valid" }, 1000, context), "invalid_request");
  const collisionKey = `question.withdraw:${JSON.stringify([beeId, "first"])}`;
  const poison = await human.request("bee.rename", { beeId: other, name: "poison", idempotencyKey: collisionKey });
  const first = await withdraw(q.id, "first", "  Superseded.  ");
  const poisonReplay = await human.request<Record<string, unknown>>("bee.rename", { beeId: other, name: "different", idempotencyKey: collisionKey });
  assert.equal(poisonReplay.deduped, true);
  assert.deepEqual({ ...poisonReplay, deduped: undefined }, { ...poison as object, deduped: undefined });
  const probeKey = `question.withdraw:${JSON.stringify([beeId, "new-key"])}`;
  assert.equal(first.question.withdrawalReason, "Superseded.");
  const replay = await withdraw(q.id, "first", "new reason");
  assert.equal(replay.deduped, true); assert.deepEqual(replay.question, first.question);
  assert.deepEqual((await withdraw(q.id, "new-key", "different")).question, first.question);
  await refused(withdraw(q.id, "first", "stolen", other), "question_not_owner");
  const noDisclosure = await human.request<Record<string, unknown>>("bee.rename", { beeId: other, name: "no-disclosure", idempotencyKey: probeKey });
  assert.equal(noDisclosure.deduped, undefined);
  receipts.push({ receiptIsolation: { collisionKey, poison, poisonReplay, noDisclosure } });
  await refused(human.request("question.answer", { questionId: q.id, answer: "late" }), "question_withdrawn", "This question was withdrawn: Superseded.");
  const qOther = (await service.request<QuestionAskResult>("question.ask", { beeId: other, text: "Other owner same key?" })).question;
  assert.equal((await withdraw(qOther.id, "first", "Other owner.", other)).question.status, "withdrawn");
  const qReuse = await ask("Key reuse?");
  await refused(withdraw(qReuse.id, "first"), "idempotency_conflict");
  const qAnswered = await ask("Answer first?");
  const answered = await human.request<QuestionAnswerResult>("question.answer", { questionId: qAnswered.id, answer: "yes" });
  await refused(withdraw(qAnswered.id, "answered"), "question_already_answered");
  receipts.push({ first, replay, answered });
  const raceRows = [];
  for (const winner of ["withdraw", "answer"] as const) {
    const question = await ask(`Concurrent race: ${winner} first`);
    const answer = () => service.request<QuestionAnswerResult>("question.answer", { questionId: question.id, answer: "yes", idempotencyKey: `answer-${winner}` });
    // Both RPCs are outstanding before either response; frame order exercises each first-commit winner.
    const firstPromise = winner === "withdraw" ? withdraw(question.id, `race-${winner}`, "Race withdrawn.") : answer();
    const firstSettled = firstPromise.then(value => ({ status: "fulfilled", value }), error => ({ status: "rejected", error }));
    const secondPromise = winner === "withdraw" ? answer() : withdraw(question.id, `race-${winner}`, "Race withdrawn.");
    const settled = [await firstSettled, ...(await Promise.allSettled([secondPromise]))];
    assert.equal(settled.filter(r => r.status === "fulfilled").length, 1);
    const state = await service.request<SnapshotResult>("snapshot");
    const row = state.questions.find(r => r.id === question.id)!;
    const mailbox = await service.request<MailboxResult>("mailbox", { beeId });
    const mail = mailbox.messages.filter(m => m.body.startsWith(`[answer to question ${question.id}]`));
    assert.equal(row.status, winner === "withdraw" ? "withdrawn" : "answered");
    assert.equal(mail.length, winner === "withdraw" ? 0 : 1);
    const record = { winner, row, mail, settled: settled.map(r => r.status === "fulfilled" ? r : { status: r.status, code: (r as { reason?: RpcError; error?: RpcError }).reason?.code ?? (r as { error?: RpcError }).error?.code }) };
    raceRows.push(record);
  }
  receipts.push({ races: raceRows });
  await new Promise(r => setTimeout(r, 100));
  const swapAfter = await service.request<{ schemaVersion: number; storageSupported: boolean }>("update.apiarySwap.status");
  assert.equal(swapAfter.schemaVersion, 44);
  assert.equal(swapAfter.storageSupported, true);
  receipts.push({ apiarySwapAfter: swapAfter });
  const snapshot = await service.request<SnapshotResult>("snapshot");
  const mailbox = await service.request<MailboxResult>("mailbox", { beeId });
  const events = frames.flatMap(f => f.type === "delta" ? f.events : []);
  const withdrawals = events.filter(e => e.kind === "question.withdrawn" && e.payload.questionId === q.id);
  assert.equal(withdrawals.length, 1);
  assert.equal(events.filter(e => e.kind === "question.answered" && e.payload.questionId === q.id).length, 0);
  assert.equal(mailbox.messages.filter(m => m.body.startsWith(`[answer to question ${q.id}]`)).length, 0);
  const cliQuestionList = execFileSync("env", ["-i", `HOME=${process.env.HOME}`, `PATH=${process.env.PATH}`, `HIVE_NODE_PATH=${process.execPath}`, process.execPath, resolve("dist/cli.js"), "v2", "question", "list", "--data-dir", data, "--socket", socket], { encoding: "utf8" });
  assert.ok(cliQuestionList.includes("withdrawn"));
  assert.ok(cliQuestionList.includes("reason: Superseded."));
  receipts.push({ watch: withdrawals, snapshot, mailbox, cliQuestionList });
  await stop();
  const store = openCoreStore(join(data, "core.sqlite3"));
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  writeFileSync(join(evidence, "audit.json"), JSON.stringify(store.auditRows(), null, 2));
  store.close();
  service = await start();
  await refused(withdraw(q.id, "first"), "caller_not_trusted");
  await register(service);
  const reconnected = await service.request<SnapshotResult>("watch");
  assert.deepEqual(reconnected.questions.find(r => r.id === q.id), first.question);
  assert.deepEqual((await withdraw(q.id, "first")).question, first.question);
  const listed = await service.request<{ questions: unknown[] }>("question.list", { open: false });
  assert.ok(listed.questions.some(r => (r as { id: string }).id === q.id));
  receipts.push({ replay: "audit equals authoritative dump", reconnect: reconnected.questions, dedupAfterRestart: "stable", passed: true });
  await stop();
  writeFileSync(join(evidence, "receipts.json"), JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify({ passed: true, host: hostname(), root, evidence, raceWinners: raceRows.map(r => r.row.status) }));
} finally { await stop(); }
