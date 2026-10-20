import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";
import { openCoreStore } from "../../v2/core/src/index.ts";
import type { SnapshotResult, SpawnResult, ViewResult, AccountAdmissionAcquireResult } from "../../v2/daemon/src/protocol.ts";

const root = process.env.C_LAB_ROOT!;
assert.ok(root.startsWith("/var/tmp/hb-quota-C.C4."));
const proof = join(root, "results");
const repo = resolve(".");
const requests: unknown[] = [];
const rpc: unknown[] = [];
const resetAt = Date.now() + 10000;
const authority = { node: "owner-H1", epoch: "C4-epoch" };
const usage = createServer((request, response) => {
  const used = Date.now() >= resetAt ? 5 : 100;
  const reset = Date.now() >= resetAt ? resetAt + 3600000 : resetAt;
  requests.push({ at: Date.now(), used, reset, path: request.url });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(request.url?.includes("profile") ? { account: { uuid: "fixture" }, organization: { uuid: "fixture-org", organization_type: "claude_max" } } : { five_hour: { utilization: used, resets_at: new Date(reset).toISOString() }, seven_day: { utilization: used, resets_at: new Date(reset).toISOString() } }));
});
await new Promise<void>(done => usage.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${(usage.address() as AddressInfo).port}`;
const rigs = ["owner-H1", "execution-H2"].map(node => makeDaemonDir({ accounts: { allocationMode: "active", allocationNodeId: node, allocationOwner: authority }, agents: { claude: { command: process.execPath, args: [join(repo, ".proof/C/claude.mjs")], adapter: "claude", env: { FAKE_QUOTA_ONCE_PATH: join(root, "quota.once"), FAKE_QUOTA_RESETS_AT: new Date(resetAt).toISOString() } } } }));
for (const rig of rigs) {
  const store = openCoreStore(join(rig.dir, "core.sqlite3"), { ephemeral: true });
  const vault = join(rig.dir, "vault", "claude", "claude-source");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-only", expiresAt: 4102444800000 } }));
  store.createAccount({ id: "claude-source", harness: "claude", homePath: join(rig.dir, "homes", "claude-source"), label: "source" });
  store.putAccountLimits("claude-source", { readable: true, fetchedAt: Date.now(), fiveHour: { usedPercent: 100, resetsAt: resetAt, windowMinutes: 300 }, weekly: { usedPercent: 100, resetsAt: resetAt, windowMinutes: 10080 } });
  store.close();
}
writeFileSync(join(proof, "metadata.json"), JSON.stringify({ head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: execFileSync("git", ["status", "--short", "--untracked-files=no"], { encoding: "utf8" }), root, resetAt, nodes: [authority.node, "execution-H2"], apiaryd: false }, null, 2));
console.log(JSON.stringify({ root, proof }));
const daemons = [];
try {
  for (const rig of rigs) daemons.push(await startDaemon(rig.dir, { env: { HIVE_CLAUDE_USAGE_URL: base + "/usage", HIVE_CLAUDE_PROFILE_URL: base + "/profile" } }));
  const owner = await daemons[0]!.client();
  const execution = await daemons[1]!.client();
  const call = async <T>(side: "owner" | "execution", method: string, params: Record<string, unknown>): Promise<T> => {
    try { const result = await (side === "owner" ? owner : execution).request<T>(method, params); rpc.push({ side, method, params, result }); return result; }
    catch (error) { rpc.push({ side, method, params, error: { code: (error as { code?: string }).code, message: String(error) } }); throw error; }
  };
  const bee = await call<SpawnResult>("execution", "spawn", { name: "C4-source", agent: "claude", cwd: rigs[1]!.dir, account: "claude-source" });
  await call("execution", "send", { beeId: bee.beeId, body: "warmup" });
  await waitFor(async () => { const v = await execution.request<ViewResult>("view", { beeId: bee.beeId }); return v.view.runtimeState === "idle" && v.bee?.providerSessionId; }, "conversation initialized", 15000);
  await call("execution", "send", { beeId: bee.beeId, body: "@quota:once C4 original turn" });
  const recovery = await waitFor(async () => (await execution.request<SnapshotResult>("snapshot", {})).quotaRecoveries.find(r => r.beeId === bee.beeId && r.state === "waiting" && r.reason === "allocation_owner_required"), "owner-required obligation", 15000);
  writeFileSync(join(proof, "waiting.json"), JSON.stringify(recovery, null, 2));
  await waitFor(() => Date.now() >= resetAt, "known reset", 15000);
  const context = { version: 1, authority, scope: "claude:provider-accounts", revision: "C4-fleet", observedAt: Date.now(), complete: true, accounts: [{ account: "claude-source", active: 1, recent: 0, pending: 0, ongoingUnits: 1 }] };
  const acquireParams = { harness: "claude", operation: "swap", target: { node: "execution-H2", workId: bee.beeId, expectedGeneration: 1 }, sourceAccount: "claude-source", allowSourceAccount: true, sourceQuotaRecovery: { observedAt: recovery.createdAt, window: recovery.quota.window, resetsAt: recovery.quota.resetsAt, usedPercentAtObservation: recovery.sourceWindowUsedPercent, usedPercentObservedAt: recovery.sourceWindowObservedAt }, allocationContext: context, idempotencyKey: "C4-acquire-source" };
  const acquired = await call<AccountAdmissionAcquireResult>("owner", "account.admission.acquire", acquireParams);
  const acquireReplay = await call<AccountAdmissionAcquireResult>("owner", "account.admission.acquire", acquireParams);
  assert.equal(acquireReplay.claim?.id, acquired.claim?.id);
  assert.equal(acquired.claim?.account, "claude-source");
  assert.ok(acquired.claim?.sourceQuotaRecovery);
  const claim = acquired.claim!;
  const refused = async (label: string, params: Record<string, unknown>) => {
    await assert.rejects(() => call("execution", "bee.swapAccount", { beeId: bee.beeId, account: "auto", idempotencyKey: label, ...params }), (error: unknown) => (error as { code?: string }).code === "account_claim_refused");
  };
  await refused("C4-ordinary-source", { allocationClaim: claim });
  await refused("C4-no-witness", { allocationClaim: { ...claim, sourceQuotaRecovery: undefined }, quotaRecoveryId: recovery.id });
  await refused("C4-wrong-observation", { allocationClaim: { ...claim, sourceQuotaRecovery: { ...claim.sourceQuotaRecovery, observedAt: recovery.createdAt - 1 } }, quotaRecoveryId: recovery.id });
  await refused("C4-wrong-epoch", { allocationClaim: { ...claim, authority: { ...authority, epoch: "stale" } }, quotaRecoveryId: recovery.id });
  const params = { beeId: bee.beeId, account: "auto", allocationClaim: claim, quotaRecoveryId: recovery.id, idempotencyKey: "C4-apply-source" };
  const swapped = await call<{ to: string }>("execution", "bee.swapAccount", params);
  assert.equal(swapped.to, "claude-source");
  await call("owner", "account.admission.confirm", { claimId: claim.id, target: { node: "execution-H2", workId: bee.beeId }, idempotencyKey: "C4-confirm" });
  const replay = await call<{ deduped?: boolean }>("execution", "bee.swapAccount", params);
  assert.equal(replay.deduped, true);
  const resumed = await waitFor(async () => (await execution.request<SnapshotResult>("snapshot", {})).quotaRecoveries.find(r => r.id === recovery.id && r.state === "resumed"), "source continuation", 15000);
  assert.equal(resumed.successorGeneration, 2);
  assert.equal(resumed.continuationMessageIds.length, 1);
  const nativeResults = () => readFileSync(join(rigs[1]!.dir, "session-logs", `${bee.beeId}.jsonl`), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === "result" && row.is_error === false);
  await waitFor(async () => { const v = await execution.request<ViewResult>("view", { beeId: bee.beeId }); return v.runtime?.generation === 2 && v.view.runtimeState === "idle" && nativeResults().length === 2; }, "resumed native output idle", 15000);
  await new Promise(done => setTimeout(done, 2000));
  assert.equal(nativeResults().length, 2);
  writeFileSync(join(proof, "native.journal.jsonl"), readFileSync(join(rigs[1]!.dir, "session-logs", `${bee.beeId}.jsonl`)));
  const ownerSnapshot = await owner.request<SnapshotResult>("snapshot", {});
  const executionSnapshot = await execution.request<SnapshotResult>("snapshot", {});
  assert.equal(ownerSnapshot.accountAdmissions.length, 1);
  assert.ok(ownerSnapshot.accountAdmissions[0]!.confirmedAt);
  assert.equal(executionSnapshot.accountAdmissions.length, 1);
  const summary = { passed: true, sourceRestoreCount: 1, successorGeneration: 2, continuationCount: 1, reservationCount: ownerSnapshot.accountAdmissions.length, confirmed: true, negativeCases: ["ordinary source even with owner witness", "missing source approval witness", "wrong recovery observation", "stale owner epoch"], noApiaryd: "RPC owner saga exercised directly with two real Honeybee processes; full Apiary integration delegated to G" };
  writeFileSync(join(proof, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(proof, "final-snapshots.json"), JSON.stringify({ ownerSnapshot, executionSnapshot }, null, 2));
  console.log(JSON.stringify(summary));
  owner.close(); execution.close();
} finally {
  for (const daemon of daemons.reverse()) await daemon.stop();
  for (let i = 0; i < rigs.length; i++) writeFileSync(join(proof, `node${i}.daemon.log`), readFileSync(join(rigs[i]!.dir, "hived.log")));
  writeFileSync(join(proof, "rpc.json"), JSON.stringify(rpc, null, 2));
  writeFileSync(join(proof, "usage.json"), JSON.stringify(requests, null, 2));
  await new Promise<void>(done => usage.close(() => done()));
}
