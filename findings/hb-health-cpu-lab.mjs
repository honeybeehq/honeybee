import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const out = process.argv[2] ?? join(repo, "findings");
mkdirSync(out, { recursive: true });
const receipts = join(out, "hb-health-cpu-lab.jsonl");
writeFileSync(receipts, "");
const record = (row) => { const line = JSON.stringify({ at: new Date().toISOString(), ...row }); appendFileSync(receipts, line + "\n"); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const expect = (name, ok, detail = {}) => { record({ step: name, ok, ...detail }); if (!ok) failures.push(name); };

const { RpcClient } = await import(join(repo, "v2/cli/src/client.ts"));
const { ProcessCpuMeter, PROCESS_CPU_SAMPLE_MS } = await import(join(repo, "v2/daemon/src/processCpu.ts"));

const dir = mkdtempSync("/tmp/hb-health-cpu-");
const home = join(dir, "home");
for (const p of [home, join(home, "config"), join(home, "data"), join(home, "cache"), join(home, "state")]) mkdirSync(p, { recursive: true });
writeFileSync(join(dir, "config.json"), JSON.stringify({
  idleWindowMs: 0,
  accounts: { vaultDir: join(dir, "vault"), homesDir: join(dir, "homes"), tmuxSocket: `hb-health-cpu-${process.pid}`, limitsRefreshMs: 0 },
  agents: { stub: { command: NODE, args: [join(repo, "v2/driver-hsr/test-agent/agent.mjs")], adapter: "stub", env: { STUB_TURN_MS: "10" } } },
  naming: { auto: false },
}, null, 2));
const env = {
  PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
  HIVE_GATEWAYS_DISABLE: "1", HIVE_NO_KEYCHAIN: "1", HIVE_NODE_PATH: NODE,
  HIVE_CLAUDE_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage", HIVE_CLAUDE_PROFILE_URL: "http://127.0.0.1:9/api/oauth/profile", HIVE_CLAUDE_OAUTH_TOKEN_URL: "http://127.0.0.1:9/v1/oauth/token",
  HIVE_CODEX_OAUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token", HIVE_GROK_OAUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token", HIVE_TEST_META_URL: "http://127.0.0.1:9",
  HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1", HIVE_TEST_CELL_VOLUME_BYTES: String(1024 ** 4),
};
const hivedLog = join(out, "hb-health-cpu-hived.log");
writeFileSync(hivedLog, "");
const daemon = spawn(NODE, [join(repo, "v2/daemon/src/bin.ts"), "--data-dir", dir], { env, stdio: ["ignore", "pipe", "pipe"] });
daemon.stdout.on("data", (d) => appendFileSync(hivedLog, d));
daemon.stderr.on("data", (d) => appendFileSync(hivedLog, d));
const socketPath = join(dir, "hived.sock");
const bootStarted = Date.now();
while (!existsSync(socketPath) && Date.now() - bootStarted < 30_000) await sleep(50);
let client = await RpcClient.connect(socketPath, 10_000);
record({ step: "daemon.started", pid: daemon.pid, dataDir: dir, bootMs: Date.now() - bootStarted, capabilities: client.capabilities.length });
expect("hello.capability_tag", client.capabilities.includes("health.process_cpu.v1"), { tag: "health.process_cpu.v1" });

const clk = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
const procCpuMicros = (pid) => { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); const f = s.slice(s.lastIndexOf(")") + 2).split(" "); return (Number(f[11]) + Number(f[12])) / clk * 1e6; };
const psPercent = (pid) => Number(execFileSync("ps", ["-o", "%cpu=", "-p", String(pid)], { encoding: "utf8" }).trim());
const hiveHealth = () => JSON.parse(execFileSync(NODE, [join(repo, "dist/cli.js"), "--data-dir", dir, "--json", "health"], { encoding: "utf8", env }));
const hiveHealthText = () => execFileSync(NODE, [join(repo, "dist/cli.js"), "--data-dir", dir, "health"], { encoding: "utf8", env: { ...env, NO_COLOR: "1" } });
const topPercent = (pid, seconds) => new Promise((resolveTop) => {
  const top = spawn("top", ["-b", "-d", String(seconds), "-n", "2", "-p", String(pid)], { env: { ...process.env, COLUMNS: "200" } });
  let text = ""; top.stdout.on("data", (d) => { text += d; });
  top.on("exit", () => { const frames = text.split(/\n(?=top - )/); const last = frames[frames.length - 1]; const row = last.split("\n").find((l) => l.trim().startsWith(String(pid))); const cols = row?.trim().split(/\s+/); resolveTop(cols ? Number(cols[8]) : null); });
});

const first = hiveHealth();
expect("health.json.before_window", first.processCpu === null || first.processCpu.schema === 1, { processCpu: first.processCpu, pid: first.pid });

async function window(name) {
  const start = { wall: process.hrtime.bigint(), cpu: procCpuMicros(daemon.pid) };
  const topDone = topPercent(daemon.pid, 60);
  await sleep(60_000 + PROCESS_CPU_SAMPLE_MS);
  const procPercent = Math.round((procCpuMicros(daemon.pid) - start.cpu) / (Number(process.hrtime.bigint() - start.wall) / 1e3) * 1000) / 10;
  const health = hiveHealth();
  const top = await topDone;
  const ps = psPercent(daemon.pid);
  const cpu = health.processCpu;
  const delta = Math.abs(cpu.percent - procPercent);
  expect(`${name}.health_matches_proc`, cpu !== null && cpu.schema === 1 && cpu.windowMs >= 55_000 && cpu.windowMs <= 65_000 && delta <= 3, { health: cpu, procStatPercent: procPercent, topPercent: top, psLifetimePercent: ps, deltaPoints: delta });
  return { health: cpu, procPercent, top, ps };
}

const idle = await window("idle");
const text = hiveHealthText();
expect("health.text.cpu_line", /\bcpu\b.*%.*avg over 6\ds/.test(text), { line: text.split("\n").find((l) => l.includes("cpu")) });
const info = await client.request("deployInfo", {});
expect("deployInfo.carries_processCpu", info.processCpu !== null && info.processCpu.schema === 1 && info.capabilities.includes("health.process_cpu.v1"), { processCpu: info.processCpu });

const bees = [];
for (let i = 0; i < 5; i += 1) { const r = await client.request("spawn", { name: `load-${i}`, agent: "stub", cwd: "/tmp" }); bees.push(r.beeId); }
const stateOf = async (beeId) => (await client.request("view", { beeId })).runtime?.state ?? null;
const until = Date.now() + 30_000;
while (Date.now() < until) { const states = await Promise.all(bees.map(stateOf)); if (states.every((s) => s === "idle" || s === "running")) break; await sleep(100); }
record({ step: "load.bees_up", bees: bees.length, states: await Promise.all(bees.map(stateOf)) });
let sends = 0, sending = true;
const loop = (async () => { while (sending) { await client.request("send", { beeId: bees[sends % bees.length], body: `load ${sends}` }); sends += 1; await sleep(25); } })();
const load = await window("load");
sending = false; await loop;
record({ step: "load.sends", sends, perSecond: Math.round(sends / 65 * 10) / 10 });

const meter = new ProcessCpuMeter();
const n = 200_000;
const c0 = process.cpuUsage(); const t0 = process.hrtime.bigint();
for (let i = 0; i < n; i += 1) { meter.sample(); if (i % 13 === 0) meter.status(); }
const c1 = process.cpuUsage(c0); const wallMicros = Number(process.hrtime.bigint() - t0) / 1e3;
const perSampleMicros = (c1.user + c1.system) / n;
const timerPercent = perSampleMicros / PROCESS_CPU_SAMPLE_MS / 1e3 * 100;
expect("timer.cost_under_0_1_percent", timerPercent < 0.1, { samples: n, perSampleMicros: Math.round(perSampleMicros * 100) / 100, wallPerSampleMicros: Math.round(wallMicros / n * 100) / 100, sampleEveryMs: PROCESS_CPU_SAMPLE_MS, timerPercentOfOneCore: Number(timerPercent.toFixed(5)) });

client.close?.();
daemon.kill("SIGTERM");
const stopStarted = Date.now();
await new Promise((r) => daemon.on("exit", r));
record({ step: "daemon.stopped", pid: daemon.pid, stopMs: Date.now() - stopStarted });
record({ step: "summary", idle: { health: idle.health.percent, procStat: idle.procPercent, top: idle.top, psLifetime: idle.ps }, load: { health: load.health.percent, procStat: load.procPercent, top: load.top, psLifetime: load.ps }, timerPercentOfOneCore: Number(timerPercent.toFixed(5)), failures });
process.exit(failures.length ? 1 : 0);
