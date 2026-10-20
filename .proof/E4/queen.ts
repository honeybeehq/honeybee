import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { openCoreStore } from "../../v2/core/src/index.ts";
import { AccountsService } from "../../v2/daemon/src/accountsService.ts";
import { loadNodeConfig } from "../../v2/daemon/src/config.ts";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const proof = resolve(".proof/E4");
const repo = resolve(".");
const selected = new Set(process.argv.slice(2));
const results: any[] = selected.size && existsSync(join(proof, "queen-summary.json")) ? JSON.parse(readFileSync(join(proof, "queen-summary.json"), "utf8")).filter((row: any) => !selected.has(row.name)) : [];
for (const harness of ["claude", "codex"]) for (const scenario of ["stale-target", "unreadable", "cross", "mixed", "active-three", "near-window", "backed-off"]) {
  const name = `${harness}-queen-${scenario}`;
  if (selected.size && !selected.has(name)) continue;
  const usage = new Map([[`${harness}-a`, scenario === "mixed" ? 99.9 : scenario === "near-window" ? 99 : 90], [`${harness}-b`, scenario === "active-three" ? 50 : scenario === "cross" ? 10 : 5], [`${harness}-c`, 10]]);
  let targetsDelayed = false;
  const reset = Math.ceil((Date.now() + (scenario === "near-window" ? 1_800_000 : 10_800_000)) / 1000) * 1000;
  let readable = true;
  const server = createServer(async (req, res) => {
    if (!readable) { res.statusCode = 503; res.end("fixture unavailable"); return; }
    const id = new URL(req.url!, "http://127.0.0.1").searchParams.get("id") ?? `${harness}-${req.headers.authorization?.endsWith("c") ? "c" : req.headers.authorization?.endsWith("b") ? "b" : "a"}`;
    if (targetsDelayed && !id.endsWith("-a")) {
      await new Promise(done => setTimeout(done, 500));
      if (scenario === "unreadable") { res.statusCode = 503; res.end(JSON.stringify({ error: "fixture unavailable" })); return; }
    }
    const weekly = scenario === "cross" && id.endsWith("-b") ? 85 : scenario === "near-window" && id.endsWith("-a") ? 99 : 5;
    const pct = scenario === "source-reset" && id.endsWith("-a") && Date.now() >= reset ? 5 : usage.get(id) ?? 5;
    const observedReset = Date.now() >= reset ? reset + 3_600_000 : reset;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ five_hour: { utilization: pct, resets_at: new Date(observedReset).toISOString() }, seven_day: { utilization: weekly, resets_at: new Date(reset + 86_400_000).toISOString() }, rateLimits: { planType: (scenario === "mixed" || scenario === "active-three") && !id.endsWith("-b") ? "large" : "small", primary: { usedPercent: pct, windowDurationMins: 300, resetsAt: Math.floor(observedReset / 1000) }, secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: Math.floor((reset + 86_400_000) / 1000) } } }));
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
  const { dir } = makeDaemonDir({ accounts: { allocationPlanCapacityUnits: { large: 20, small: 1 }, allocationMode: scenario === "active-three" ? "active" : "shadow", allocationNodeId: "lab", allocationOwner: { node: "lab", epoch: "lab-e" }, allocationQuotaFreshMs: scenario === "stale-target" || scenario === "unreadable" || scenario === "backed-off" ? 2000 : 120_000 }, agents: {
    [harness]: { command: harness === "codex" ? fakeCodex : process.execPath, args: harness === "codex" ? [] : [join(repo, "v2/driver-hsr/test-agent/fake-claude.mjs")], adapter: harness, ...(harness === "codex" ? { env: { FAKE_CODEX_STRICT_HOME: "1" } } : {}) },
  } });
  writeFileSync(join(proof, `${name}.root.log`), dir);
  for (const label of (scenario === "active-three" ? ["a", "b", "c"] : ["a", "b"])) {
    const vault = join(dir, "vault", harness, `${harness}-${label}`);
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, harness === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify(harness === "claude" ? { claudeAiOauth: { accessToken: `fixture-${label}`, subscriptionType: (scenario === "mixed" || scenario === "active-three") && label !== "b" ? "large" : "small", expiresAt: 4102444800000 } } : { tokens: { access_token: `fixture-${label}` } }));
  }
  let daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_USAGE_URL: url } });
  let client = await daemon.client();
  const daemonLogs: string[] = [];
  const rpc: unknown[] = [];
  const request = async (method: string, params: any = {}) => { const result = await client.request<any>(method, params); rpc.push({ method, params, result }); return result; };
  try {
    for (const label of (scenario === "active-three" ? ["a", "b", "c"] : ["a", "b"])) await request("account.add", { harness, label, importExisting: true });
    await request("account.limits");
    if (scenario === "backed-off") {
      client.close();
      await daemon.stop();
      const store = openCoreStore(join(dir, "core.sqlite3"));
      const cfg = loadNodeConfig(dir);
      const service = new AccountsService({ store, cfg, log: () => undefined });
      const now = Date.now();
      const cadence = { account: `${harness}-b`, lastProbeAt: now - 6 * 60_000, nextProbeAt: now + 15 * 60_000, delayMs: 15 * 60_000, evidence: (service as any).quotaProbeEvidence(`${harness}-b`) };
      store.putAccountQuotaProbeCadence(cadence, "backoff");
      store.close();
      rpc.push({ method: "seeded_backoff_fixture", result: cadence });
      daemon = await startDaemon(dir, { env: { HIVE_CLAUDE_USAGE_URL: url } });
      client = await daemon.client();
    }
    const bee = await request("spawn", { name, agent: harness, cwd: dir, account: `${harness}-a`, ...(scenario === "optout" || scenario === "active-three" ? { tags: ["autoswap=false"] } : {}) });
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
    if (scenario === "active-three") {
      const warm = await send("warm conversation before keyed account swap");
      await delivered(warm.messageId);
      await idle();
      await request("bee.tag", { beeId, remove: ["autoswap=false"] });
    }
    let sourceAt: number | undefined;
    let targetAt: number | undefined;
    if (scenario === "stale-target" || scenario === "unreadable" || scenario === "backed-off") {
      const before = await request("account.limits");
      targetAt = before.limits.find((l: any) => l.account === `${harness}-b` || l.id === `${harness}-b`)?.fetchedAt;
      await new Promise(done => setTimeout(done, 2300));
      const source = await request("account.limits", { id: `${harness}-a` });
      sourceAt = source.limits[0]?.fetchedAt;
      targetsDelayed = true;
    }
    if (scenario === "stale-target" || scenario === "unreadable" || scenario === "backed-off") {
      assert(sourceAt !== undefined && targetAt !== undefined && sourceAt - targetAt > 2000, "source fetch fresh; target fetch beyond configured freshness");
    }
    const startedAt = Date.now();
    const sent = await send("Queen relative regression original mail");
    if (scenario === "active-three") {
      const recovery = await waitFor(async () => (await request("snapshot")).quotaRecoveries.find((r: any) => r.beeId === beeId && r.state === "waiting" && r.admission?.candidateAccountIds?.length), `${name} candidates`);
      assert.deepEqual(recovery.admission.candidateAccountIds, [`${harness}-c`]);
      const allocationContext = { version: 1, scope: `${harness}:provider-accounts`, authority: { node: "lab", epoch: "lab-e" }, revision: name, observedAt: Date.now(), complete: true, accounts: [] };
      const acquire = (label: string) => request("account.admission.acquire", { harness, operation: "swap", target: { node: "lab", workId: beeId, expectedGeneration: 1 }, sourceAccount: `${harness}-a`, allocationContext: { ...allocationContext, observedAt: Date.now() }, onlyAccountIds: [`${harness}-${label}`], idempotencyKey: `${name}-${label}` });
      const bad = await acquire("b");
      let refused: any;
      try { await request("bee.swapAccount", { beeId, account: "auto", quotaRecoveryId: recovery.id, allocationClaim: bad.claim, idempotencyKey: `${name}-bad-swap` }); } catch (error) { refused = error; }
      rpc.push({ method: "bad_claim_refusal", result: { code: refused?.code, details: refused?.details } });
      assert.equal(refused?.code, "account_claim_refused");
      assert.equal(refused?.details?.fenced, true);
      const good = await acquire("c");
      const swapParams = { beeId, account: "auto", quotaRecoveryId: recovery.id, allocationClaim: good.claim, onlyAccountIds: recovery.admission.candidateAccountIds, idempotencyKey: `${name}-good-swap` };
      const applied = await request("bee.swapAccount", swapParams);
      const replay = await request("bee.swapAccount", swapParams);
      assert.equal(replay.deduped, true);
      assert.equal(replay.commandId, applied.commandId);
    }
    const mail = await delivered(sent.messageId);
    await idle();
    const switched = ["stale-target", "mixed", "active-three", "near-window", "backed-off"].includes(scenario);
    assert.equal(mail.deliveredGeneration, switched ? 2 : 1);
    const view = await request("view", { beeId });
    assert.equal(view.bee.account, `${harness}-${switched ? scenario === "active-three" ? "c" : "b" : "a"}`);
    const rows = (await request("snapshot")).quotaRecoveries.filter((r: any) => r.beeId === beeId);
    if (scenario === "cross") assert.equal(rows.length, 0);
    if (scenario === "stale-target" || scenario === "backed-off") {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, "resumed");
      const audits = (await request("audit.tail", { beeId, limit: 1000 })).rows;
      assert(audits.some((r: any) => r.kind === "quota.recovery" && r.payload.recovery.admission.candidateAccountIds === null));
    }
    if (scenario === "backed-off") {
      assert(Date.now() - startedAt < 10000, "backoff must not postpone proactive target sampling");
      assert(rows.every((r: any) => r.state === "resumed"));
    }
    if (scenario === "unreadable") {
      assert(rows.every((r: any) => r.state === "cancelled"));
      assert(Date.now() - startedAt < 10000, "unreadable target must not hold delivery indefinitely");
    }
    results.push({ name, passed: true, deliveredGeneration: mail.deliveredGeneration, account: view.bee.account, recoveries: rows.map((r: any) => ({ state: r.state, reason: r.reason })), sourceAt, targetAt, elapsedMs: Date.now() - startedAt });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    writeFileSync(join(proof, `${name}.rpc.json`), JSON.stringify(rpc, null, 2));
    client.close();
    await daemon.stop();
    writeFileSync(join(proof, `${name}.daemon.log`), daemon.output() + (existsSync(join(dir, "hived.log")) ? readFileSync(join(dir, "hived.log"), "utf8") : ""));
    await new Promise<void>(done => server.close(() => done()));
    writeFileSync(join(proof, "queen-summary.json"), JSON.stringify(results, null, 2));
  }
}
