import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const proof = resolve(".proof/E");
const repo = resolve(".");
const selected = new Set(process.argv.slice(2));
const results: any[] = selected.size && existsSync(join(proof, "summary.json")) ? JSON.parse(readFileSync(join(proof, "summary.json"), "utf8")).filter((row: any) => !selected.has(row.name)) : [];
for (const harness of ["claude", "codex"]) for (const scenario of ["human", "worker", "action", "projected", "headroom", "healthy", "subside", "restart", "stale", "running", "both", "source-reset", "optout", "active"]) {
  const name = `${harness}-${scenario}`;
  if (selected.size && !selected.has(name)) continue;
  const usage = new Map([[`${harness}-a`, 5], [`${harness}-b`, 5]]);
  const reset = Math.ceil((Date.now() + (scenario === "source-reset" ? 5000 : 3_600_000)) / 1000) * 1000;
  const server = createServer((req, res) => {
    const id = new URL(req.url!, "http://127.0.0.1").searchParams.get("id") ?? `${harness}-${req.headers.authorization?.endsWith("b") ? "b" : "a"}`;
    const pct = scenario === "source-reset" && id.endsWith("-a") && Date.now() >= reset ? 5 : usage.get(id) ?? 5;
    const observedReset = Date.now() >= reset ? reset + 3_600_000 : reset;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ five_hour: { utilization: pct, resets_at: new Date(observedReset).toISOString() }, seven_day: { utilization: 5, resets_at: new Date(reset + 86_400_000).toISOString() }, rateLimits: { primary: { usedPercent: pct, windowDurationMins: 300, resetsAt: Math.floor(observedReset / 1000) }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: Math.floor((reset + 86_400_000) / 1000) } } }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const fakeCodex = join(process.env.TMPDIR!, `codex-${name}.mjs`);
  let source = readFileSync(join(repo, "v2/driver-hsr/test-agent/fake-codex.mjs"), "utf8");
  source = source.replace('case "initialize":', `case "account/rateLimits/read":
      void fetch(${JSON.stringify(url)} + '/?id=' + encodeURIComponent(process.env.CODEX_HOME.split('/').at(-1))).then(r => r.json()).then(result => emit({id: msg.id, result}));
      return;
    case "initialize":`);
  writeFileSync(fakeCodex, source);
  chmodSync(fakeCodex, 0o700);
  const { dir } = makeDaemonDir({ accounts: { allocationMode: scenario === "active" ? "active" : "shadow", allocationNodeId: "lab", allocationOwner: { node: "lab", epoch: "lab-e" }, allocationQuotaFreshMs: scenario === "stale" ? 500 : 120_000 }, agents: {
    [harness]: { command: harness === "codex" ? fakeCodex : process.execPath, args: harness === "codex" ? [] : [join(repo, "v2/driver-hsr/test-agent/fake-claude.mjs")], adapter: harness, ...(harness === "codex" ? { env: { FAKE_CODEX_STRICT_HOME: "1" } } : {}) },
  } });
  writeFileSync(join(proof, `${name}.root.log`), dir);
  for (const label of ["a", "b"]) {
    const vault = join(dir, "vault", harness, `${harness}-${label}`);
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, harness === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify(harness === "claude" ? { claudeAiOauth: { accessToken: `fixture-${label}`, expiresAt: 4102444800000 } } : { tokens: { access_token: `fixture-${label}` } }));
  }
  let daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_USAGE_URL: url } });
  let client = await daemon.client();
  const daemonLogs: string[] = [];
  const rpc: unknown[] = [];
  const request = async (method: string, params: any = {}) => { const result = await client.request<any>(method, params); rpc.push({ method, params, result }); return result; };
  try {
    for (const label of ["a", "b"]) await request("account.add", { harness, label, importExisting: true });
    await request("account.limits");
    const bee = await request("spawn", { name, agent: harness, cwd: dir, account: `${harness}-a`, ...(scenario === "optout" ? { tags: ["autoswap=false"] } : {}) });
    const beeId = bee.beeId;
    const worker = scenario === "worker" ? await request("spawn", { name: name + "-sender", agent: "stub", cwd: dir, account: null }) : null;
    const send = (body: string, peer = false) => request("send", { beeId, body, ...(peer ? { sender: worker.beeId } : {}) });
    let lastDeliveredId: number | null = null;
    const delivered = async (id: number) => {
      const message = await waitFor(async () => (await request("mailbox", { beeId })).messages.find((m: any) => m.id === id && m.deliveredAt !== null), `${name} delivery`, 20000);
      lastDeliveredId = id;
      return message;
    };
    const idle = async () => waitFor(async () => {
      const result = await request("view", { beeId });
      return result.view.runtimeState === "idle" && result.bee.lastTurnTrigger?.messageId === lastDeliveredId && result.bee.lastTurnTrigger?.endedAt !== null;
    }, `${name} idle`, 15000);
    const warm = await send("warm conversation");
    await delivered(warm.messageId);
    await idle();
    let running: any;
    if (scenario === "running") {
      running = await send("@slow:1500 accepted work");
      await delivered(running.messageId);
      await waitFor(async () => (await request("view", { beeId })).view.runtimeState === "running", `${name} running`);
    }
    usage.set(`${harness}-a`, scenario === "healthy" ? 5 : scenario === "projected" || scenario === "both" ? 87 : 91);
    if (scenario === "both" || scenario === "source-reset") usage.set(`${harness}-b`, scenario === "both" ? 87 : 91);
    if (scenario === "headroom") usage.set(`${harness}-b`, 85);
    if (scenario === "subside" || scenario === "restart") usage.set(`${harness}-b`, 91);
    await request("account.limits");
    if (scenario === "stale") await new Promise(done => setTimeout(done, 800));
    if (scenario === "running") {
      const before = await request("view", { beeId });
      assert.equal(before.view.generation, 1);
      await idle();
      assert.equal((await request("view", { beeId })).view.generation, 1);
    } else {
      let sent: any;
      let action: any;
      if (scenario === "action") {
        action = await request("action.enqueue", { beeId, idempotencyKey: name, items: [{ kind: "commit" }] });
        sent = await waitFor(async () => {
          const mail = (await request("mailbox", { beeId })).messages.find((m: any) => m.id !== warm.messageId);
          return mail ? { messageId: mail.id } : null;
        }, `${name} dispatch`);
      } else sent = await send(`next ${scenario} continues conversation`, scenario === "worker");
      if (scenario === "subside" || scenario === "restart") {
        const waiting = async () => waitFor(async () => {
          const rows = (await request("snapshot")).quotaRecoveries.filter((r: any) => r.beeId === beeId);
          return rows.some((r: any) => r.state === "waiting") ? rows : null;
        }, `${name} held`);
        const before = await waiting();
        if (scenario === "subside") {
          usage.set(`${harness}-a`, 85);
          await request("account.limits");
          await new Promise(done => setTimeout(done, 150));
          assert.equal((await waiting()).length, 1);
          assert.equal((await request("mailbox", { beeId })).messages.find((m: any) => m.id === sent.messageId).deliveredAt, null);
        }
        if (scenario === "restart") {
          client.close();
          await daemon.kill();
          daemonLogs.push(daemon.output());
          daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_USAGE_URL: url } });
          client = await daemon.client();
          assert.equal((await waiting())[0].id, before[0].id);
        }
        usage.set(`${harness}-a`, 5);
        await request("account.limits");
        assert.equal((await delivered(sent.messageId)).deliveredGeneration, 1);
        await idle();
        assert.ok(reset > Date.now());
        assert.equal((await request("snapshot")).quotaRecoveries.find((r: any) => r.id === before[0].id).reason, "completion_headroom_restored");
        if (scenario === "subside") {
          usage.set(`${harness}-a`, 91);
          await request("account.limits");
          const next = await send("a later turn must be admitted again");
          assert.equal((await waiting()).length, 2);
          usage.set(`${harness}-a`, 5);
          await request("account.limits");
          assert.equal((await delivered(next.messageId)).deliveredGeneration, 1);
          await idle();
        }
      } else if (scenario === "both" || scenario === "active") {
        await waitFor(async () => (await request("snapshot")).quotaRecoveries.some((r: any) => r.beeId === beeId && r.reason === (scenario === "active" ? "allocation_owner_required" : "account_wait")), `${name} waiting`);
        const first = await request("snapshot");
        for (let i = 0; i < (scenario === "both" ? 34 : 20); i++) { await new Promise(done => setTimeout(done, scenario === "both" ? 1000 : 25)); await request("snapshot"); }
        const last = await request("snapshot");
        assert.equal(last.accountAdmissions.length, first.accountAdmissions.length);
        const rows = last.quotaRecoveries.filter((r: any) => r.beeId === beeId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].state, "waiting");
        assert.ok(rows[0].retryAt > Date.now());
        assert.equal((await request("view", { beeId })).view.generation, 1);
        const tail = await request("audit.tail", { beeId, limit: 1000 });
        const notices = tail.rows.filter((r: any) => r.kind === "quota.recovery" && r.payload.notice);
        assert.equal(new Set(notices.map((r: any) => r.payload.notice.recoveryId)).size, 1);
      } else {
        const mail = await delivered(sent.messageId);
        if (scenario === "source-reset") assert.ok(mail.deliveredGeneration === 1 || mail.deliveredGeneration === 2);
        else assert.equal(mail.deliveredGeneration, scenario === "stale" || scenario === "optout" || scenario === "healthy" ? 1 : 2);
        await idle();
        const snapshot = await request("snapshot");
        const recoveries = snapshot.quotaRecoveries.filter((r: any) => r.beeId === beeId);
        if (scenario === "stale" || scenario === "optout" || scenario === "healthy") assert.equal(recoveries.length, 0);
        else {
          assert.equal(recoveries.length, 1);
          assert.equal(recoveries[0].trigger, "proactive");
          assert.equal(recoveries[0].quota, null);
          assert.equal(recoveries[0].interrupted, false);
          if (recoveries[0].state === "cancelled") {
            assert.equal(scenario, "source-reset");
            assert.equal(recoveries[0].reason, "completion_headroom_restored");
            assert.equal(recoveries[0].continuationKind, null);
          } else assert.equal(recoveries[0].continuationKind, "none");
          assert.deepEqual(recoveries[0].continuationMessageIds, []);
          assert.equal((await request("view", { beeId })).bee.account, `${harness}-${scenario === "source-reset" ? "a" : "b"}`);
          if (action) assert.equal((await request("action.get", { actionId: action.actions[0].id })).action.status, "running");
          const again = await send("conversation still continues");
          assert.equal((await delivered(again.messageId)).deliveredGeneration, mail.deliveredGeneration);
          await idle();
        }
      }
    }
    const audit = await request("audit.tail", { beeId, limit: 1000 });
    assert.equal(audit.rows.filter((r: any) => r.kind === "quota.observed").length, 0);
    const journal = join(dir, "session-logs", `${beeId}.jsonl`);
    if (existsSync(journal)) writeFileSync(join(proof, `${name}.journal.jsonl`), readFileSync(journal));
    results.push({ name, passed: true });
    console.log(JSON.stringify(results.at(-1)));
  } catch (error) {
    console.error(name, error);
    throw error;
  } finally {
    writeFileSync(join(proof, `${name}.rpc.json`), JSON.stringify(rpc, null, 2));
    client.close();
    await daemon.stop().catch(error => console.error("cleanup", String(error)));
    writeFileSync(join(proof, `${name}.daemon.log`), [...daemonLogs, daemon.output()].join("\nRESTART\n") + (existsSync(join(dir, "hived.log")) ? readFileSync(join(dir, "hived.log"), "utf8") : ""));
    await new Promise<void>(done => server.close(() => done()));
    writeFileSync(join(proof, "summary.json"), JSON.stringify(results, null, 2));
  }
}
