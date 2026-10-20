import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const proof = resolve(".proof/E2");
const repo = resolve(".");
for (const harness of ["claude", "codex"]) for (const ending of ["cancel", "optout", "owner", "credential"]) {
  const name = `${harness}-${ending}`;
  const reset = Date.now() + 86400000;
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ five_hour: { utilization: 91, resets_at: new Date(reset).toISOString() }, seven_day: { utilization: 91, resets_at: new Date(reset).toISOString() }, rateLimits: { primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: Math.floor(reset / 1000) }, secondary: { usedPercent: 91, windowDurationMins: 10080, resetsAt: Math.floor(reset / 1000) } } }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const fakeCodex = join(process.env.TMPDIR!, `${name}.mjs`);
  writeFileSync(fakeCodex, readFileSync(join(repo, "v2/driver-hsr/test-agent/fake-codex.mjs"), "utf8").replace('case "initialize":', `case "account/rateLimits/read":
    void fetch(${JSON.stringify(url)}).then(r => r.json()).then(result => emit({id: msg.id, result})); return;
    case "initialize":`));
  chmodSync(fakeCodex, 0o700);
  const { dir } = makeDaemonDir({ accounts: { allocationMode: (ending === "owner" || ending === "credential") ? "active" : "shadow", allocationNodeId: "lab", allocationOwner: { node: "lab", epoch: "e2" }, proactiveAdmission: false }, agents: {
    [harness]: { command: harness === "codex" ? fakeCodex : process.execPath, args: harness === "codex" ? [] : [join(repo, "v2/driver-hsr/test-agent/fake-claude.mjs")], adapter: harness, ...(harness === "codex" ? { env: { FAKE_CODEX_STRICT_HOME: "1" } } : {}) },
  } });
  for (const label of ["a", "b"]) {
    const vault = join(dir, "vault", harness, `${harness}-${label}`);
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, harness === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify(harness === "claude" ? { claudeAiOauth: { accessToken: `fixture-${label}`, expiresAt: 4102444800000 } } : { tokens: { access_token: `fixture-${label}` } }));
  }
  const daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_USAGE_URL: url } });
  const client = await daemon.client();
  const rpc: unknown[] = [];
  const request = async (method: string, params: any = {}) => { const result = await client.request<any>(method, params); rpc.push({ method, params, result }); return result; };
  let beeId = "";
  try {
    for (const label of ["a", "b"]) await request("account.add", { harness, label, importExisting: true });
    await request("account.limits");
    beeId = (await request("spawn", { name, agent: harness, cwd: dir, account: `${harness}-a` })).beeId;
    const warm = await request("send", { beeId, body: "warm output for the unread cursor" });
    await waitFor(async () => { const v = await request("view", { beeId }); return v.view.runtimeState === "idle" && v.bee.lastTurnTrigger?.messageId === warm.messageId && v.bee.lastTurnTrigger?.endedAt; }, "warm idle");
    await request("send", { beeId, body: "@quota:weekly fixture automatic wait" });
    const waiting = await waitFor(async () => {
      const snapshot = await request("snapshot");
      const recovery = snapshot.quotaRecoveries.find((row: any) => row.beeId === beeId && row.state === "waiting" && ["account_wait", "account_unavailable", "allocation_owner_required"].includes(row.reason));
      const current = await request("view", { beeId });
      return recovery && current.view.runtimeState === "idle" && current.view.flags.includes("resource_blocked") ? { recovery, current } : null;
    }, "all exhausted automatic wait", 20000);
    if (ending === "owner" || ending === "credential") assert.equal(waiting.recovery.reason, "allocation_owner_required");
    else assert.equal(waiting.recovery.reason, "account_wait");
    assert.equal(waiting.current.view.waitingForYou, false);
    assert.equal(waiting.current.view.blocked, true);
    const listed = await request("list");
    const listRow = listed.views.find((row: any) => row.bee.id === beeId);
    assert.equal(listRow.view.waitingForYou, false);
    assert.ok(listRow.view.flags.includes("resource_blocked"));
    if (ending === "credential") await request("quota.recovery.wait", { quotaRecoveryId: waiting.recovery.id, reason: "account_unavailable", reasonDetail: "credential_login_required", retryAt: null });
    else if (ending !== "cancel") await request("bee.tag", { beeId, add: ["autoswap=false"] });
    else await request("stop", { beeId });
    const attention = await waitFor(async () => {
      const current = await request("view", { beeId });
      const snapshot = await request("snapshot");
      const recovery = snapshot.quotaRecoveries.find((row: any) => row.id === waiting.recovery.id);
      return current.view.waitingForYou && (ending !== "cancel" || recovery?.state === "cancelled") ? { current, recovery } : null;
    }, "manual attention restored");
    assert.equal(attention.current.view.blocked, true);
    assert.ok(attention.current.view.flags.includes("resource_blocked"));
    const listedAfter = await request("list");
    assert.equal(listedAfter.views.find((row: any) => row.bee.id === beeId).view.waitingForYou, true);
    console.log(JSON.stringify({ name, passed: true, before: { waitingForYou: false, blocked: true, recovery: waiting.recovery.state, reason: waiting.recovery.reason }, after: { waitingForYou: true, blocked: true, recovery: attention.recovery.state, reason: attention.recovery.reason, reasonDetail: attention.recovery.reasonDetail }, flags: attention.current.view.flags }));
    await request("audit.tail", { beeId, limit: 1000 });
  } finally {
    writeFileSync(join(proof, `${name}.rpc.json`), JSON.stringify(rpc, null, 2));
    const journal = join(dir, "session-logs", `${beeId}.jsonl`);
    if (existsSync(journal)) writeFileSync(join(proof, `${name}.journal.jsonl`), readFileSync(journal));
    client.close();
    await daemon.stop();
    writeFileSync(join(proof, `${name}.daemon.log`), daemon.output() + (existsSync(join(dir, "hived.log")) ? readFileSync(join(dir, "hived.log"), "utf8") : ""));
    await new Promise<void>(done => server.close(() => done()));
  }
}
