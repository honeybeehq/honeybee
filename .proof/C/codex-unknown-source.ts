import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";
import { openCoreStore } from "../../v2/core/src/index.ts";
import type { SnapshotResult, ViewResult, SpawnResult, MailboxResult } from "../../v2/daemon/src/protocol.ts";

const root = resolve(process.env.C_LAB_ROOT!);
const proof = resolve(process.env.C_LAB_RESULTS!);
assert.ok(root.startsWith("/var/tmp/hb-quota-C."));
assert.ok(proof.startsWith(root + "/"));
const repo = resolve(".");
const fixturePath = join(root, "usage-fixture.json");
const probeLog = join(proof, "probes.jsonl");
writeFileSync(probeLog, "");
writeFileSync(fixturePath, JSON.stringify({ recoverAt: Number.MAX_SAFE_INTEGER, log: probeLog }));
const metadata = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), trackedChanges: execFileSync("git", ["status", "--short", "--untracked-files=no"], { encoding: "utf8" }), node: process.version, root, repo };
writeFileSync(join(proof, "metadata.json"), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify({ root, proof, metadata }));
const { dir } = makeDaemonDir({ accounts: { allocationMode: "shadow" }, agents: { codex: { command: join(repo, ".proof/C/codex.mjs"), args: [], adapter: "codex" } } });
const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
try {
  for (const label of ["a", "b"]) {
    const id = `codex-${label}`;
    const vault = join(dir, "vault", "codex", id);
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "auth.json"), JSON.stringify({ tokens: { access_token: `fixture-${label}` } }));
    store.createAccount({ id, harness: "codex", homePath: join(dir, "homes", id), label });
    store.putAccountLimits(id, { readable: true, fetchedAt: Date.now() - 60000, fiveHour: { usedPercent: label === "a" ? 85 : 100, resetsAt: null, windowMinutes: 300 }, weekly: { usedPercent: label === "a" ? 85 : 100, resetsAt: null, windowMinutes: 10080 } });
    if (label === "b") store.recordAccountExhaustion(id, Date.now());
  }
} finally { store.close(); }
const daemon = await startDaemon(dir, { env: { C_CODEX_UNKNOWN_USAGE_FILE: fixturePath } });
const client = await daemon.client();
let beeId: string | undefined;
let result: Record<string, unknown> = { passed: false, name: "codex-unknown-source", dir };
const snapshot = () => client.request<SnapshotResult>("snapshot", {});
const recovery = async () => (await snapshot()).quotaRecoveries.find(row => row.beeId === beeId);
const dump = async (name: string) => {
  const state = await snapshot();
  const view = beeId ? await client.request<ViewResult>("view", { beeId }) : null;
  const mail = beeId ? await client.request<MailboxResult>("mailbox", { beeId }) : null;
  const audit = await client.request("audit.tail", { beeId, limit: 1000 });
  writeFileSync(join(proof, `${name}.json`), JSON.stringify({ state, view, mail, audit }, null, 2));
  return { state, view, mail, audit };
};
try {
  const born = await client.request<SpawnResult>("spawn", { name: "C-codex-unknown-source", agent: "codex", cwd: dir, account: "codex-a" });
  beeId = born.beeId;
  const warmup = await client.request<{ messageId: number }>("send", { beeId, body: "Codex unknown-reset lab warmup" });
  await waitFor(async () => {
    const mail = await client.request<MailboxResult>("mailbox", { beeId });
    const view = await client.request<ViewResult>("view", { beeId });
    return mail.messages.some(row => row.id === warmup.messageId && row.deliveredGeneration === 1) && view.view.runtimeState === "idle" ? true : null;
  }, "Codex warmup served", 20000);
  const before = await dump("before-quota");
  assert.equal(before.state.accountLimits.find(row => row.account === "codex-a")?.fiveHourPct, 85);
  const recoverAt = Date.now() + 32000;
  writeFileSync(fixturePath, JSON.stringify({ recoverAt, log: probeLog }));
  const sent = await client.request<{ messageId: number }>("send", { beeId, body: "@quota:native interrupted unknown-reset task" });
  const baseline = await waitFor(async () => {
    const row = await recovery();
    return row?.sourceWindowUsedPercent === 100 && row.sourceWindowObservedAt! > row.createdAt && row.reason !== null ? row : null;
  }, "first fresh post-observation100 baseline replaces cached85", 15000);
  assert.equal(baseline.state, "waiting");
  assert.equal(baseline.quota.window, "other");
  assert.equal(baseline.quota.resetsAt, null);
  assert.equal(baseline.retryAt, null);
  assert.ok(baseline.messageIds.includes(sent.messageId));
  await dump("fresh-baseline");
  result = { ...result, originalMessageId: sent.messageId, recoveryId: baseline.id, recoverAt, sourceWindowUsedPercent: baseline.sourceWindowUsedPercent, sourceWindowObservedAt: baseline.sourceWindowObservedAt };
  console.log(JSON.stringify({ phase: "baseline", ...result }));
  const resumed = await waitFor(async () => {
    const row = await recovery();
    return row?.state === "resumed" ? row : null;
  }, "unknown reset source resumes from later fresh low usage without send", 85000);
  assert.equal(resumed.id, baseline.id);
  assert.equal(resumed.sourceWindowUsedPercent, 100);
  assert.equal(resumed.sourceWindowObservedAt, baseline.sourceWindowObservedAt);
  assert.equal(resumed.targetAccount, "codex-a");
  assert.equal(resumed.continuationKind, "continue");
  assert.equal(resumed.continuationMessageIds.length, 1);
  await waitFor(async () => {
    const journal = readFileSync(join(dir, "session-logs", `${beeId}.jsonl`), "utf8");
    const completeLines = journal.slice(0, journal.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const mail = await client.request<MailboxResult>("mailbox", { beeId });
    const view = await client.request<ViewResult>("view", { beeId });
    return completeLines.filter(row => row.method === "turn/completed" && row.params?.turn?.status === "completed").length >= 2
      && mail.messages.find(row => row.id === resumed.continuationMessageIds[0])?.deliveredGeneration === 2 && view.view.runtimeState === "idle" ? true : null;
  }, "warmup and continuation both natively completed", 15000);
  const after = await dump("resumed");
  assert.equal(after.view?.view.generation, 2);
  assert.equal(after.view?.bee?.account, "codex-a");
  assert.equal(after.view?.bee?.env.CODEX_HOME, join(dir, "homes", "codex-a"));
  assert.equal(after.mail?.messages.length, 3);
  assert.equal(after.mail?.messages.find(row => row.id === sent.messageId)?.deliveredGeneration, 1);
  assert.equal(after.mail?.messages.find(row => row.id === resumed.continuationMessageIds[0])?.deliveredGeneration, 2);
  const sourceLimits = after.state.accountLimits.find(row => row.account === "codex-a")!;
  assert.ok(sourceLimits.fetchedAt > baseline.sourceWindowObservedAt!);
  assert.equal(sourceLimits.fiveHourPct, 5);
  assert.equal(sourceLimits.weeklyPct, 5);
  const probes = readFileSync(probeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const sourceProbes = probes.filter(row => row.account === "codex-a");
  assert.equal(sourceProbes[0].used, 100);
  assert.ok(sourceProbes.some(row => row.used === 5 && row.at >= recoverAt && row.at > baseline.sourceWindowObservedAt!));
  assert.ok(probes.filter(row => row.account === "codex-b").every(row => row.used === 100));
  assert.ok(probes.every(row => row.resetsAt === null));
  result = { ...result, passed: true, continuationMessageIds: resumed.continuationMessageIds, sourceProbes, resumedFetchedAt: sourceLimits.fetchedAt };
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
  await dump("failure").catch(() => undefined);
} finally {
  if (beeId) await client.request("stop", { beeId }).catch(() => undefined);
  client.close();
  await daemon.stop();
  writeFileSync(join(proof, "daemon.log"), daemon.output() + readFileSync(join(dir, "hived.log"), "utf8"));
  if (beeId && existsSync(join(dir, "session-logs", `${beeId}.jsonl`))) writeFileSync(join(proof, "journal.jsonl"), readFileSync(join(dir, "session-logs", `${beeId}.jsonl`)));
  writeFileSync(join(proof, "summary.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
