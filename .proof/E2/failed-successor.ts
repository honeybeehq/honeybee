import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const proof = resolve(".proof/E2");
const repo = resolve(".");
for (const harness of ["claude"]) for (const ending of ["failed"]) {
  const name = `${harness}-${ending}`;
  const reset = Date.now() + 86400000;
  const server = createServer((req, res) => {
    const percent = req.headers.authorization?.endsWith("b") ? 5 : 91;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ five_hour: { utilization: percent, resets_at: new Date(reset).toISOString() }, seven_day: { utilization: percent, resets_at: new Date(reset).toISOString() }, rateLimits: { primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: Math.floor(reset / 1000) }, secondary: { usedPercent: percent, windowDurationMins: 10080, resetsAt: Math.floor(reset / 1000) } } }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const fakeCodex = join(process.env.TMPDIR!, `${name}.mjs`);
  writeFileSync(fakeCodex, readFileSync(join(repo, "v2/driver-hsr/test-agent/fake-codex.mjs"), "utf8").replace('case "initialize":', `case "account/rateLimits/read":
    void fetch(${JSON.stringify(url)}).then(r => r.json()).then(result => emit({id: msg.id, result})); return;
    case "initialize":`));
  chmodSync(fakeCodex, 0o700);
  const failedClaude = join(process.env.TMPDIR!, "failed-successor.mjs");
  writeFileSync(failedClaude, `if (process.env.CLAUDE_CONFIG_DIR?.endsWith('claude-b')) {
    process.stdin.once('data', () => process.exit(1));
    setInterval(() => {}, 1000);
  } else await import(${JSON.stringify(join(repo, "v2/driver-hsr/test-agent/fake-claude.mjs"))});`);
  const { dir } = makeDaemonDir({ accounts: { allocationMode: (ending === "owner" || ending === "credential") ? "active" : "shadow", allocationNodeId: "lab", allocationOwner: { node: "lab", epoch: "e2" }, proactiveAdmission: false }, agents: {
    [harness]: { command: harness === "codex" ? fakeCodex : process.execPath, args: harness === "codex" ? [] : [failedClaude], adapter: harness, ...(harness === "codex" ? { env: { FAKE_CODEX_STRICT_HOME: "1" } } : {}) },
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
    const stalled = await waitFor(async () => {
      const snapshot = await request("snapshot");
      const recovery = snapshot.quotaRecoveries.find((row: any) => row.beeId === beeId && row.state === "rotating");
      const current = await request("view", { beeId });
      const messages = (await request("mailbox", { beeId })).messages;
      return recovery && current.view.runtimeState === "stopped" && current.view.flags.includes("spawn_failed") && messages.some((message: any) => recovery.continuationMessageIds.includes(message.id) && message.deliveredAt === null) ? { recovery, current } : null;
    }, "successor exhausted boot budget", 30000);
    assert.equal(stalled.current.view.waitingForYou, true);
    assert.equal(stalled.current.view.blocked, true);
    assert.ok(stalled.current.view.flags.includes("resource_blocked"));
    const mail = (await request("mailbox", { beeId })).messages;
    const owed = mail.filter((row: any) => stalled.recovery.continuationMessageIds.includes(row.id) && row.deliveredAt === null);
    assert.ok(owed.length > 0, "the replay or conservative continue must remain owed");
    const listed = await request("list");
    assert.equal(listed.views.find((row: any) => row.bee.id === beeId).view.waitingForYou, true);
    console.log(JSON.stringify({ name, passed: true, state: stalled.recovery.state, runtimeState: stalled.current.view.runtimeState, waitingForYou: stalled.current.view.waitingForYou, flags: stalled.current.view.flags, owedMessageIds: owed.map((row: any) => row.id), continuationKind: stalled.recovery.continuationKind }));
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
