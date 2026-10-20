import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve, join } from "node:path";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";
import { openCoreStore } from "../../v2/core/src/index.ts";
import type { QuotaRecoveryRow } from "../../v2/core/src/types.ts";
import type { SnapshotResult, ViewResult, SpawnResult, MailboxResult } from "../../v2/daemon/src/protocol.ts";

const repo = resolve(".");
const root = resolve(process.env.C_LAB_ROOT ?? "");
const proof = resolve(process.env.C_LAB_RESULTS ?? "");
assert.ok(root.startsWith("/var/tmp/hb-quota-C."));
assert.ok(proof.startsWith(root + "/"));
mkdirSync(proof, { recursive: true });
console.log(JSON.stringify({ root, proof, pid: process.pid }));
writeFileSync(join(proof, "metadata.json"), JSON.stringify({ head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), trackedChanges: execFileSync("git", ["status", "--short", "--untracked-files=no"], { encoding: "utf8" }), node: process.version, executable: process.execPath, args: process.argv.slice(2), holdMs: Number(process.env.C_HOLD_MS ?? 33000), repo, root }, null, 2));
const scenarios = ["claude-once", "codex-once", "source-reset", "unknown-reset", "autoswap-false", "active-owner", "restart-waiting"];
const selected = process.argv.slice(2);
for (const name of selected) assert.ok(scenarios.includes(name), `unknown scenario ${name}`);
const summary: unknown[] = [];
for (const name of selected.length ? selected : scenarios) {
  const harness = name === "codex-once" ? "codex" : "claude";
  const waiting = ["source-reset", "unknown-reset", "restart-waiting"].includes(name);
  const unknown = name === "unknown-reset";
  const active = name === "active-owner";
  const resetAt = Date.now() + (waiting ? 12_000 : 3_600_000);
  const marker = join(root, `${name}.once`);
  const requests: unknown[] = [];
  const usage = createServer((request, response) => {
    const source = request.headers.authorization === "Bearer fixture-a";
    const used = waiting ? source && !unknown && Date.now() >= resetAt ? 5 : 100 : 5;
    const resets = unknown ? null : new Date(source ? resetAt : resetAt + 3_600_000).toISOString();
    requests.push({ at: Date.now(), path: request.url, account: source ? "a" : "b", used, resets });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url?.includes("profile") ? { account: { uuid: "fixture" }, organization: { uuid: "fixture-org", organization_type: "claude_max" } } : { five_hour: { utilization: used, resets_at: resets }, seven_day: { utilization: used, resets_at: resets } }));
  });
  await new Promise<void>(done => usage.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(usage.address() as AddressInfo).port}`;
  const { dir } = makeDaemonDir({ accounts: {
    allocationMode: active ? "active" : "shadow",
    ...(active ? { allocationNodeId: "c-worker", allocationOwner: { node: "c-owner", epoch: "c-owner-v1" } } : {}),
  }, agents: { [harness]: {
    command: harness === "codex" ? join(repo, ".proof/C/codex.mjs") : process.execPath,
    args: harness === "codex" ? [] : [join(repo, ".proof/C/claude.mjs")], adapter: harness,
    env: { FAKE_QUOTA_ONCE_PATH: marker, FAKE_QUOTA_RESETS_AT: new Date(resetAt).toISOString(), FAKE_QUOTA_RESETS_AT_SECONDS: String(Math.floor(resetAt / 1000)), C_UNKNOWN_RESET: unknown ? "1" : "0" },
  } } });
  const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  try {
    for (const label of ["a", "b"]) {
      const id = `${harness}-${label}`;
      const vault = join(dir, "vault", harness, id);
      mkdirSync(vault, { recursive: true });
      writeFileSync(join(vault, harness === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify(harness === "claude" ? { claudeAiOauth: { accessToken: `fixture-${label}`, expiresAt: 4102444800000 } } : { tokens: { access_token: `fixture-${label}` } }));
      store.createAccount({ id, harness, homePath: join(dir, "homes", id), label });
      store.putAccountLimits(id, { readable: true, fetchedAt: Date.now(), fiveHour: { usedPercent: waiting ? 100 : 5, resetsAt: unknown ? null : resetAt, windowMinutes: 300 }, weekly: { usedPercent: waiting ? 100 : 5, resetsAt: unknown ? null : resetAt, windowMinutes: 10080 } });
      if (waiting && label === "b") store.recordAccountExhaustion(id, Date.now());
    }
  } finally { store.close(); }
  const env = { HIVE_CLAUDE_USAGE_URL: `${base}/usage`, HIVE_CLAUDE_PROFILE_URL: `${base}/profile` };
  let daemon = await startDaemon(dir, { env });
  let client = await daemon.client();
  const logs: string[] = [];
  let beeId: string | undefined;
  let result: Record<string, unknown> = { name, harness, dir, resetAt: unknown ? null : resetAt, passed: false };
  const dump = async (suffix: string) => {
    const snapshot = await client.request<SnapshotResult>("snapshot", {});
    const view = beeId ? await client.request<ViewResult>("view", { beeId }) : null;
    const mail = beeId ? await client.request<MailboxResult>("mailbox", { beeId }) : null;
    const audit = await client.request("audit.tail", { beeId, limit: 1000 });
    writeFileSync(join(proof, `${name}.${suffix}.json`), JSON.stringify({ snapshot, view, mail, audit }, null, 2));
    return { snapshot, view, mail, audit };
  };
  const recovery = async () => (await client.request<SnapshotResult>("snapshot", {})).quotaRecoveries.find(row => row.beeId === beeId);
  try {
    const bee = await client.request<SpawnResult>("spawn", { name: `C-${name}`, agent: harness, cwd: dir, account: `${harness}-a`, ...(name === "autoswap-false" ? { tags: ["autoswap=false"] } : {}) });
    beeId = bee.beeId;
    const warmup = await client.request<{ messageId: number }>("send", { beeId, body: "quota lab warmup" });
    await waitFor(async () => {
      const mail = await client.request<MailboxResult>("mailbox", { beeId });
      const view = await client.request<ViewResult>("view", { beeId });
      return mail.messages.some(message => message.id === warmup.messageId && message.deliveredGeneration === 1) && view.view.runtimeState === "idle" && !!view.bee?.providerSessionId ? true : null;
    }, `${name} native conversation initialized`, 15_000);
    const sent = await client.request<{ messageId: number }>("send", { beeId, body: "@quota:once exact original quota work" });
    const initial = await waitFor(async () => await recovery(), `${name} durable obligation`, 20_000);
    assert.ok(initial.messageIds.includes(sent.messageId));
    result.originalMessageId = sent.messageId;
    result.recoveryId = initial.id;
    if (waiting || active || name === "autoswap-false") {
      await waitFor(async () => {
        const row = await recovery();
        const view = await client.request<ViewResult>("view", { beeId });
        return row?.state === "waiting" && row.reason !== null && view.view.runtimeState === "idle" ? row : null;
      }, `${name} waiting idle`, 10_000);
      const before = await dump("waiting");
      assert.equal(before.view?.view.generation, 1);
      if (waiting) {
        const row = before.snapshot.quotaRecoveries.find(row => row.id === initial.id)!;
        assert.equal(row.retryAt === null, unknown, "known reset must be scheduled; unknown reset must remain unknown");
        if (!unknown) assert.ok(row.retryAt! >= resetAt - 1000 && row.retryAt! <= resetAt + 1000, "retry tracks source capacity reset");
      }
      if (active) assert.equal(before.snapshot.quotaRecoveries.find(row => row.id === initial.id)?.reason, "allocation_owner_required");
      if (name === "restart-waiting") {
        client.close();
        await daemon.kill();
        logs.push(daemon.output());
        daemon = await startDaemon(dir, { env });
        client = await daemon.client();
        assert.equal((await recovery())?.id, initial.id);
        await dump("restarted");
      }
    }
    if (unknown || active || name === "autoswap-false") {
      await new Promise(done => setTimeout(done, Number(process.env.C_HOLD_MS ?? 33000)));
      const held = await dump("held");
      const row = held.snapshot.quotaRecoveries.find(row => row.id === initial.id)!;
      assert.equal(row.state, "waiting");
      assert.equal(row.reason, unknown ? "account_unavailable" : active ? "allocation_owner_required" : "autoswap_disabled");
      assert.deepEqual(row.continuationMessageIds, []);
      assert.equal(held.view?.view.generation, 1);
      assert.equal(held.mail?.messages.length, 2);
      assert.equal(held.view?.view.flags.includes("auth_needed"), false);
      result = { ...result, passed: true, state: row.state, reason: row.reason, retryAt: row.retryAt };
    } else {
      const resumed = await waitFor(async () => {
        const row = await recovery();
        return row?.state === "resumed" ? row : null;
      }, `${name} automatic no-send continuation`, 45_000);
      assert.equal(resumed.continuationMessageIds.length, 1);
      assert.equal(resumed.continuationKind, harness === "codex" ? "continue" : "replay");
      assert.equal(resumed.progress, harness === "codex" ? "unknown" : "none");
      assert.equal(resumed.targetAccount, `${harness}-${waiting ? "a" : "b"}`);
      await waitFor(async () => {
        const mail = await client.request<MailboxResult>("mailbox", { beeId });
        const view = await client.request<ViewResult>("view", { beeId });
        const journal = readFileSync(join(dir, "session-logs", `${beeId}.jsonl`), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
        const completed = journal.filter(row => harness === "claude" ? row.type === "result" && row.is_error === false : row.method === "turn/completed" && row.params?.turn?.status === "completed");
        return completed.length >= 2 && mail.messages.some(message => message.id === resumed.continuationMessageIds[0] && message.deliveredGeneration === 2) && view.view.runtimeState === "idle" && !view.view.flags.includes("resource_blocked") ? true : null;
      }, `${name} continuation delivered and served`, 15_000);
      const after = await dump("resumed");
      assert.equal(after.view!.bee!.account, resumed.targetAccount);
      assert.equal(after.view!.bee!.env[harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"], join(dir, "homes", resumed.targetAccount!));
      assert.equal(after.mail!.messages.length, 3);
      assert.equal(after.mail!.messages.find(message => message.id === sent.messageId)?.deliveredGeneration, 1, "original delivery remains charged to source generation");
      assert.equal(after.snapshot.quotaRecoveries.filter(row => row.beeId === beeId).length, 1);
      const audit = after.audit as { rows: Array<{ kind: string; payload: { recovery?: QuotaRecoveryRow } }> };
      assert.equal(audit.rows.filter(row => row.kind === "quota.recovery" && row.payload.recovery?.state === "resumed").length, 1);
      assert.equal(audit.rows.filter(row => row.kind === "action.report").length, 0);
      if (harness === "claude") assert.equal(resumed.quota.window, "weekly");
      else assert.ok(audit.rows.some(row => row.kind === "quota.observed"));
      const journal = readFileSync(join(dir, "session-logs", `${beeId}.jsonl`), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      const completed = journal.filter(row => harness === "claude" ? row.type === "result" && row.is_error === false : row.method === "turn/completed" && row.params?.turn?.status === "completed");
      assert.equal(completed.length, 2, "warmup and one successful continuation turn");
      result = { ...result, passed: true, state: resumed.state, kind: resumed.continuationKind, targetAccount: resumed.targetAccount, continuationMessageIds: resumed.continuationMessageIds };
    }
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
    await dump("failure").catch(() => undefined);
    process.exitCode = 1;
  } finally {
    if (beeId) await client.request("stop", { beeId }).catch(() => undefined);
    client.close();
    await daemon.stop();
    logs.push(daemon.output());
    writeFileSync(join(proof, `${name}.daemon.log`), logs.join("\nRESTART\n") + (existsSync(join(dir, "hived.log")) ? readFileSync(join(dir, "hived.log"), "utf8") : ""));
    if (beeId && existsSync(join(dir, "session-logs", `${beeId}.jsonl`))) writeFileSync(join(proof, `${name}.journal.jsonl`), readFileSync(join(dir, "session-logs", `${beeId}.jsonl`)));
    writeFileSync(join(proof, `${name}.usage.json`), JSON.stringify(requests, null, 2));
    await new Promise<void>((done, reject) => usage.close(error => error ? reject(error) : done()));
    summary.push(result);
    writeFileSync(join(proof, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(result));
  }
}
