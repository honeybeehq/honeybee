import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const proof = resolve(".proof/E4");
const repo = resolve(".");
const selected = new Set(process.argv.slice(2));
const results: any[] = selected.size && existsSync(join(proof, "active-summary.json")) ? JSON.parse(readFileSync(join(proof, "active-summary.json"), "utf8")).filter((row: any) => !selected.has(row.name)) : [];
for (const harness of ["claude", "codex"]) for (const scenario of ["most", "switch"]) {
  const name = `${harness}-active-${scenario}`;
  if (selected.size && !selected.has(name)) continue;
  const usage = new Map([[`${harness}-a`, 90], [`${harness}-b`, scenario === "most" ? 80 : scenario === "equal" ? 86 : 5]]);
  const reset = Math.ceil((Date.now() + (scenario === "reset" ? 1_800_000 : 10_800_000)) / 1000) * 1000;
  let readable = true;
  const server = createServer((req, res) => {
    if (!readable) { res.statusCode = 503; res.end("fixture unavailable"); return; }
    const id = new URL(req.url!, "http://127.0.0.1").searchParams.get("id") ?? `${harness}-${req.headers.authorization?.endsWith("b") ? "b" : "a"}`;
    const pct = scenario === "source-reset" && id.endsWith("-a") && Date.now() >= reset ? 5 : usage.get(id) ?? 5;
    const observedReset = Date.now() >= reset ? reset + 3_600_000 : reset;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ five_hour: { utilization: pct, resets_at: new Date(observedReset).toISOString() }, seven_day: { utilization: 5, resets_at: new Date(reset + 86_400_000).toISOString() }, rateLimits: { planType: id.endsWith("a") && scenario === "most" ? "large" : "small", primary: { usedPercent: pct, windowDurationMins: 300, resetsAt: Math.floor(observedReset / 1000) }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: Math.floor((reset + 86_400_000) / 1000) } } }));
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
  const { dir } = makeDaemonDir({ accounts: { allocationPlanCapacityUnits: { large: 20, small: 1 }, allocationMode: "active", allocationNodeId: "lab", allocationOwner: { node: "lab", epoch: "lab-e" }, allocationQuotaFreshMs: scenario === "stale" ? 500 : 120_000 }, agents: {
    [harness]: { command: harness === "codex" ? fakeCodex : process.execPath, args: harness === "codex" ? [] : [join(repo, "v2/driver-hsr/test-agent/fake-claude.mjs")], adapter: harness, ...(harness === "codex" ? { env: { FAKE_CODEX_STRICT_HOME: "1" } } : {}) },
  } });
  writeFileSync(join(proof, `${name}.root.log`), dir);
  for (const label of ["a", "b"]) {
    const vault = join(dir, "vault", harness, `${harness}-${label}`);
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, harness === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify(harness === "claude" ? { claudeAiOauth: { accessToken: `fixture-${label}`, subscriptionType: label === "a" && scenario === "most" ? "large" : "small", expiresAt: 4102444800000 } } : { tokens: { access_token: `fixture-${label}` } }));
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
    if (scenario === "stale") await new Promise(done => setTimeout(done, 800));
    const first = await send("active relative trigger");
    if (scenario === "switch") {
      const row = await waitFor(async () => (await request("snapshot")).quotaRecoveries.find((r: any) => r.beeId === beeId && r.state === "waiting"), `${name} owner obligation`);
      assert.equal(row.reason, "allocation_owner_required");
      assert.equal(row.quota, null);
      assert.equal((await request("mailbox", { beeId })).messages.find((m: any) => m.id === first.messageId).deliveredAt, null);
    } else {
      assert.equal((await delivered(first.messageId)).deliveredGeneration, 1);
      await idle();
      assert.equal((await request("snapshot")).quotaRecoveries.filter((r: any) => r.beeId === beeId).length, 0);
    }
    results.push({ name, passed: true, ownerRequired: scenario === "switch" });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    writeFileSync(join(proof, `${name}.rpc.json`), JSON.stringify(rpc, null, 2));
    client.close();
    await daemon.stop();
    writeFileSync(join(proof, `${name}.daemon.log`), daemon.output());
    await new Promise<void>(done => server.close(() => done()));
    writeFileSync(join(proof, "active-summary.json"), JSON.stringify(results, null, 2));
  }
}
