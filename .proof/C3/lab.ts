import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { openCoreStore } from "../../v2/core/src/index.ts";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const repo = resolve(".");
const root = process.env.C_LAB_ROOT!;
const proof = join(root, "results");
const clock = join(root, "offset");
writeFileSync(clock, "0");
const logicalNow = () => Date.now() + Number(readFileSync(clock, "utf8"));
const jump = (at: number) => { writeFileSync(`${clock}.next`, String(at - Date.now())); renameSync(`${clock}.next`, clock); };
const resetAt = Date.now() + 4_000_000;
const requests: Array<{ account: string; wallAt: number; logicalAt: number; used: number }> = [];
const events: unknown[] = [];
let targetResetChanged = false;
const server = createServer((request, response) => {
  const account = request.headers.authorization === "Bearer fixture-a" ? "claude-a" : "claude-b";
  const logicalAt = logicalNow();
  const count = requests.filter(row => row.account === account).length;
  const used = logicalAt >= resetAt && account === "claude-a" ? 5 : 98 + count / 100;
  const nextReset = logicalAt >= resetAt && account === "claude-a" ? resetAt + 604_800_000 : resetAt + (count % 2) + (targetResetChanged && account === "claude-b" ? 60_000 : 0);
  response.writeHead(200, { "content-type": "application/json" });
  if (request.url?.includes("profile")) response.end(JSON.stringify({ account: { uuid: "fixture" }, organization: { uuid: "fixture-org", organization_type: "claude_max" } }));
  else {
    requests.push({ account, wallAt: Date.now(), logicalAt, used });
    response.end(JSON.stringify({ five_hour: { utilization: used, resets_at: new Date(nextReset).toISOString() }, seven_day: { utilization: used, resets_at: new Date(nextReset).toISOString() } }));
  }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { dir } = makeDaemonDir({ accounts: { allocationMode: "shadow", limitsRefreshMs: 0 }, agents: { claude: {
  command: process.execPath, args: [join(repo, "v2/driver-hsr/test-agent/fake-claude.mjs")], adapter: "claude",
  env: { FAKE_QUOTA_ONCE_PATH: join(root, "once"), FAKE_QUOTA_RESETS_AT: new Date(resetAt).toISOString() },
} } });
const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
for (const label of ["a", "b"]) {
  const account = `claude-${label}`;
  const vault = join(dir, "vault", "claude", account);
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `fixture-${label}`, expiresAt: 4102444800000 } }));
  store.createAccount({ id: account, harness: "claude", homePath: join(dir, "homes", account), label });
  store.putAccountLimits(account, { readable: true, fetchedAt: Date.now(), fiveHour: { usedPercent: 98, resetsAt: resetAt, windowMinutes: 300 }, weekly: { usedPercent: 98, resetsAt: resetAt, windowMinutes: 10080 } });
  if (label === "b") store.recordAccountExhaustion(account, Date.now());
}
store.close();
const env = { HIVE_CLAUDE_USAGE_URL: `${url}/usage`, HIVE_CLAUDE_PROFILE_URL: `${url}/profile`, C3_CLOCK_PATH: clock, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${join(repo, ".proof/C3/clock.mjs")}` };
let daemon = await startDaemon(dir, { env });
let client = await daemon.client();
const outputs: string[] = [];
const beeIds: string[] = [];
const sourceRequests = () => requests.filter(row => row.account === "claude-a");
const audit = () => client.request<any>("audit.tail", { limit: 10000 });
const cadence = async (account = "claude-a") => (await audit()).rows.filter((row: any) => row.kind === "account.quota_probe" && row.payload.cadence.account === account).at(-1)?.payload.cadence;
const state = () => client.request<any>("snapshot", {});
const settle = async (beeId: string, body: string) => {
  const sent = await client.request<any>("send", { beeId, body });
  await waitFor(async () => {
    const mail = await client.request<any>("mailbox", { beeId });
    const view = await client.request<any>("view", { beeId });
    return mail.messages.find((row: any) => row.id === sent.messageId)?.deliveredAt != null && view.view.runtimeState === "idle" ? true : null;
  }, `served ${body}`, 15000);
};
console.log(JSON.stringify({ root, proof, dir }));
writeFileSync(join(proof, "metadata.json"), JSON.stringify({ head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), trackedChanges: execFileSync("git", ["status", "--short", "--untracked-files=no"], { encoding: "utf8" }), clock: "accelerated Date.now; wallAt is real time; logicalAt is injected daemon scheduling time", resetAt, root, dir }, null, 2));
try {
  for (const name of ["interrupted", "neighbor"]) {
    const born = await client.request<any>("spawn", { name: `C3-${name}`, agent: "claude", cwd: dir, account: "claude-a" });
    beeIds.push(born.beeId);
    await settle(born.beeId, "warmup");
  }
  await settle(beeIds[0]!, "@quota:once interrupted work");
  await waitFor(async () => await cadence(), "initial cadence");
  let current = await cadence();
  assert.equal(current.delayMs, 30000);
  events.push({ phase: "initial", cadence: current });
  for (const expected of [60000, 120000, 240000, 480000, 900000, 900000, 900000]) {
    const before = sourceRequests().length;
    jump(current.nextProbeAt - 1800);
    await settle(beeIds[1]!, "neighbor succeeds and clears account exhaustion");
    await settle(beeIds[1]!, "@quota:weekly neighbor refreshes exhaustion stamp");
    await new Promise(done => setTimeout(done, 250));
    assert.equal(sourceRequests().length, before, "exhaustion churn must not bypass cadence");
    jump(current.nextProbeAt + 30);
    await waitFor(() => sourceRequests().length > before ? true : null, "next backoff probe", 10000);
    current = await waitFor(async () => {
      const row = await cadence();
      return row.delayMs === expected ? row : null;
    }, `cadence ${expected}`);
    events.push({ phase: "backoff", cadence: current });
  }
  const persisted = { ...current };
  const beforeRestart = sourceRequests().length;
  client.close();
  await daemon.kill();
  outputs.push(daemon.output());
  daemon = await startDaemon(dir, { env });
  client = await daemon.client();
  await new Promise(done => setTimeout(done, 300));
  assert.equal(sourceRequests().length, beforeRestart, "restart must not reset the probe timer");
  assert.equal((await cadence()).nextProbeAt, persisted.nextProbeAt);
  jump(persisted.nextProbeAt - 2000);
  await new Promise(done => setTimeout(done, 250));
  assert.equal(sourceRequests().length, beforeRestart);
  jump(persisted.nextProbeAt + 30_100);
  await waitFor(() => sourceRequests().length > beforeRestart ? true : null, "persisted deadline probe");
  current = await cadence();
  assert.equal(current.delayMs, 900000);
  events.push({ phase: "restart_preserved", cadence: current });
  targetResetChanged = true;
  await client.request("account.limits", { id: "claude-b" });
  await waitFor(async () => (await cadence("claude-b"))?.delayMs === 30000 ? true : null, "fresh reset evidence resets target cadence");
  events.push({ phase: "fresh_evidence", cadence: await cadence("claude-b") });
  assert.ok(current.nextProbeAt > resetAt);
  const beforeReset = sourceRequests().length;
  jump(resetAt + 30);
  await waitFor(() => sourceRequests().length > beforeReset ? true : null, "known reset immediate probe");
  const resumed = await waitFor(async () => (await state()).quotaRecoveries.find((row: any) => row.beeId === beeIds[0] && row.state === "resumed"), "source automatically resumes after reset", 20000);
  await waitFor(async () => {
    const mail = await client.request<any>("mailbox", { beeId: beeIds[0] });
    return mail.messages.some((row: any) => row.id === resumed.continuationMessageIds[0] && row.deliveredGeneration === 2) ? true : null;
  }, "continuation delivered");
  assert.equal(resumed.targetAccount, "claude-a");
  const rows = (await audit()).rows;
  assert.ok(rows.some((row: any) => row.kind === "account.quota_probe" && row.payload.reason === "reset" && row.payload.cadence.account === "claude-a"));
  events.push({ phase: "known_reset_resumed", cadence: await cadence(), recovery: resumed });
  writeFileSync(join(proof, "final-rpc.json"), JSON.stringify({ state: await state(), audit: rows }, null, 2));
  writeFileSync(join(proof, "summary.json"), JSON.stringify({ passed: true, events, requests }, null, 2));
  console.log(JSON.stringify({ passed: true, sourceProbes: sourceRequests().length, capMs: 900000, resetAt, resumed: resumed.id }));
} finally {
  for (const beeId of beeIds) await client.request("stop", { beeId }).catch(() => undefined);
  client.close();
  await daemon.stop();
  outputs.push(daemon.output());
  writeFileSync(join(proof, "requests.json"), JSON.stringify(requests, null, 2));
  writeFileSync(join(proof, "probe-cadence.log"), ["Accelerated daemon clock: logicalAt is scheduling time; wallAt is real request time.", ...requests.map(row => JSON.stringify(row)), ...events.map(row => JSON.stringify(row))].join("\n") + "\n");
  writeFileSync(join(proof, "daemon.log"), outputs.join("\nRESTART\n") + (existsSync(join(dir, "hived.log")) ? readFileSync(join(dir, "hived.log"), "utf8") : ""));
  for (const beeId of beeIds) {
    const journal = join(dir, "session-logs", `${beeId}.jsonl`);
    if (existsSync(journal)) writeFileSync(join(proof, `${beeId}.journal.jsonl`), readFileSync(journal));
  }
  await new Promise<void>(done => server.close(() => done()));
}
