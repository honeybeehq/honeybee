// macOS lab for the fleet-rollout switch path: a scratch node on this Mac under /var/tmp with its own
// data dir, runtime root and plist, loaded into the real launchd under the fake label hb.fleet.lab
// (never dev.honeybee.hive.v2). The old build is a copy of an installed darwin-arm64 runtime laid
// out like an Apiary install and started from a mini-shaped explicit-entry plist; three stub bees
// run across the swap. scripts/fleet-rollout.mjs is driven with host "local" and --lab-root.
//   node .proof/fleet-rollout/lab-mac.mjs --old ~/.hive/runtime/<oldSha> --sha <installedSha> [--keep]
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) { const k = argv[i].slice(2); opt[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
const need = (k) => { if (opt[k] === undefined) throw new Error(`--${k} required`); return opt[k]; };
const OLD = resolve(need("old").replace(/^~/, homedir())), SHA = need("sha"), NAME = opt.name ?? "mac-hop";
const NODE = process.execPath;
const LABEL = "hb.fleet.lab";
const UID = userInfo().uid;
const OUT = join(here, `${NAME}.jsonl`);
const lines = [];
const record = (entry) => { const row = { at: new Date().toISOString(), ...entry }; lines.push(row); writeFileSync(OUT, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`); console.log(JSON.stringify(row).slice(0, 600)); };
const fail = (message) => { record({ step: "FAIL", message }); throw new Error(message); };
const expect = (name, passed, detail = {}) => { const pass = Boolean(passed); record({ step: name, pass, ...detail }); if (!pass) fail(`${name}: ${JSON.stringify(detail).slice(0, 2000)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastJson = (text) => { const line = text.trim().split("\n").filter((l) => l.startsWith("{")).at(-1); try { return line ? JSON.parse(line) : null; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const root = `/var/tmp/hb-mac-lab-${Date.now().toString(36)}`;
const L = { root, dataDir: join(root, "v2"), runtimeRoot: join(root, "runtime"), units: join(root, "units"), bin: join(root, "bin"), plist: join(root, "units", `${LABEL}.plist`) };
const oldIdentity = JSON.parse(readFileSync(join(OLD, "dist", "build-identity.json"), "utf8"));
if (oldIdentity.target !== "darwin-arm64" || !/^[0-9a-f]{40}$/.test(oldIdentity.sourceRevision ?? "")) throw new Error(`${OLD} is not a clean darwin-arm64 honeybee build`);
const OLD_SHA = oldIdentity.sourceRevision;
const APIARY_HASH = "6e623fb5a64e555b51057c7896368332daef5691830da2af063449a2f996c291";
const honeybee = join(root, "apiary", "honeybee-runtime", APIARY_HASH, "lib", "node_modules", "honeybee");
const oldEntry = join(honeybee, "dist", "cli.js");
const newEntry = join(L.runtimeRoot, "current", "dist", "cli.js");
const pathEnv = `${L.bin}:${dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`;
const env = { ...process.env, PATH: pathEnv, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1", NO_COLOR: "1" };
for (const key of Object.keys(env)) if (key.startsWith("HIVE_") && !["HIVE_NO_KEYCHAIN", "HIVE_GATEWAYS_DISABLE"].includes(key)) delete env[key];

const xml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function miniPlist() {
  const nodeSha = sha256(NODE);
  const version = execFileSync(NODE, ["--version"]).toString().trim().replace(/^v/, "");
  const envs = { HIVE_V2_DATA_DIR: L.dataDir, HOME: homedir(), PATH: pathEnv, HIVE_NODE_PATH: NODE, HIVE_NODE_VERSION: version, HIVE_NODE_SHA256: nodeSha };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[NODE, oldEntry, "v2", "daemon", "run", "--data-dir", L.dataDir].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(envs).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(join(L.dataDir, "hived.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(L.dataDir, "hived.log"))}</string>
</dict>
</plist>
`;
}

async function cli(entry, args, timeout = 120_000) {
  try { const r = await execFileAsync(NODE, [entry, ...args, "--data-dir", L.dataDir], { env, maxBuffer: 64 * 1024 * 1024, timeout }); return { code: 0, ...r, json: lastJson(r.stdout) }; }
  catch (error) { return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "", json: lastJson(error.stdout ?? "") }; }
}
async function launchctl(args) { try { const r = await execFileAsync("launchctl", args); return { code: 0, ...r }; } catch (error) { return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; } }
async function jobState() {
  const r = await launchctl(["print", `gui/${UID}/${LABEL}`]);
  if (r.code !== 0) return { loaded: false, pid: null, path: null };
  const path = /^\s*path = (.*)$/m.exec(r.stdout)?.[1] ?? null;
  return { loaded: true, pid: Number(/^\s*pid = (\d+)/m.exec(r.stdout)?.[1] ?? 0) || null, path: path && existsSync(path) ? realpathSync(path) : path, running: /state = running/.test(r.stdout) };
}
function hostState(pids) {
  const link = (name) => { try { return execFileSync("readlink", [join(L.runtimeRoot, name)]).toString().trim(); } catch { return null; } };
  const plist = readFileSync(L.plist, "utf8");
  const log = existsSync(join(L.dataDir, "hived.log")) ? readFileSync(join(L.dataDir, "hived.log"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).op; } catch { return l; } }) : [];
  return { plistSha256: sha256(L.plist), programArguments: [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]).slice(1, 8), abandonProcessGroup: /<key>AbandonProcessGroup<\/key>\s*<true\/>/.test(plist), links: { current: link("current"), previous: link("previous") }, marker: existsSync(join(L.runtimeRoot, "handover.json")), pids: Object.fromEntries(pids.map((p) => [p, alive(p)])), bootLines: log.filter((op) => /^(daemon\.started|boot adopted|boot\.handover|boot\.rollback|boot\.handover_marker_removed)/.test(op)).slice(-12) };
}
async function rollout(args, { timeoutMs = 600_000 } = {}) {
  const started = performance.now();
  const child = spawn(NODE, [join(repo, "scripts", "fleet-rollout.mjs"), "local", ...args, "--json", "--lab-root", root], { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise((r) => child.on("close", (c) => r(c)));
  clearTimeout(timer);
  const result = lastJson(stdout);
  return { code, ms: Math.round(performance.now() - started), result, stderr: stderr.slice(-1500), stepsText: (result?.steps ?? []).map((s) => `${s.step}: ${s.message ?? JSON.stringify(s)}`) };
}
async function mailLands(entry, beeId, body) {
  const sent = await cli(entry, ["send", beeId, body, "--json"]);
  if (!sent.json?.messageId) return { ok: false, sent: (sent.stdout + sent.stderr).slice(-300) };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const box = await cli(entry, ["mailbox", beeId, "--json"]);
    const row = (box.json?.messages ?? []).find((m) => m.body === body);
    if (row?.deliveredAt) return { ok: true, messageId: sent.json.messageId, deliveredGeneration: row.deliveredGeneration ?? null };
    await sleep(300);
  }
  return { ok: false, messageId: sent.json.messageId, undelivered: true };
}

let exitCode = 0, pids = [];
try {
  if ((await jobState()).loaded) throw new Error(`launchd already has ${LABEL}; refusing`);
  for (const d of [L.dataDir, L.runtimeRoot, L.units, L.bin, join(root, "tmp"), join(root, "cells")]) mkdirSync(d, { recursive: true });
  mkdirSync(dirname(honeybee), { recursive: true });
  execFileSync("cp", ["-a", OLD, honeybee]);
  rmSync(join(honeybee, "manifest.json"), { force: true });
  symlinkSync(honeybee, join(L.runtimeRoot, "current"));
  writeFileSync(L.plist, miniPlist());
  writeFileSync(join(L.dataDir, "config.json"), JSON.stringify({ naming: { auto: false }, cells: { root: join(root, "cells"), retention: { enabled: false } }, agents: { stub: { command: NODE, args: [join(repo, "v2", "driver-hsr", "test-agent", "agent.mjs")], adapter: "stub" } } }));
  const boot = await launchctl(["bootstrap", `gui/${UID}`, L.plist]);
  if (boot.code !== 0) throw new Error(`bootstrap: ${boot.stderr}`);
  let info = null;
  const started = Date.now();
  while (Date.now() - started < 120_000 && !info) { if (existsSync(join(L.dataDir, "hived.endpoint.json"))) info = (await cli(oldEntry, ["deploy-info", "--json"])).json; if (!info) await sleep(250); }
  if (!info) throw new Error("old daemon did not answer under launchd");
  const job0 = await jobState();
  const bees = [];
  for (let i = 1; i <= 3; i += 1) { const r = await cli(oldEntry, ["spawn", `mac-bee-${i}`, "--agent", "stub", "--cwd", root, "--json"]); const id = r.json?.beeId ?? r.json?.id; if (!id) throw new Error(`spawn: ${(r.stdout + r.stderr).slice(-400)}`); bees.push(id); }
  let idle = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && idle.length < 3) { const r = await cli(oldEntry, ["list", "--json"]); idle = (r.json?.views ?? []).filter((v) => bees.includes(v.bee.id) && v.runtime?.state === "idle").map((v) => ({ beeId: v.bee.id, name: v.bee.name, generation: v.runtime.generation, pid: v.runtime.pid })); if (idle.length < 3) await sleep(300); }
  if (idle.length < 3) throw new Error("stub bees did not reach idle");
  pids = idle.map((b) => b.pid);
  record({ step: "lab.setup", root, label: LABEL, uid: UID, old: OLD_SHA, running: info.identity?.sourceRevision, protocol: info.protocol, job: job0, bees: idle, bootMs: Date.now() - started });
  expect("lab.old_daemon_under_launchd", job0.loaded && job0.pid === info.pid && info.identity?.sourceRevision === OLD_SHA && job0.path === realpathSync(L.plist), { job: job0, pid: info.pid });
  const before = hostState(pids);

  const inv = await rollout(["--inventory"]);
  expect("inventory", inv.code === 0 && inv.result?.inventory?.running === OLD_SHA && inv.result.inventory.unitForm === "explicit" && inv.result.inventory.liveRuntimes === 3 && inv.result.inventory.target === "darwin-arm64", { row: inv.result?.inventory });

  const dry = await rollout([SHA, "--dry-run"]);
  const afterDry = hostState(pids);
  const jobDry = await jobState();
  record({ step: "dry_run", ms: dry.ms, steps: dry.stepsText });
  expect("dry_run.changes_nothing", dry.code === 0 && dry.result?.dryRun === true && afterDry.plistSha256 === before.plistSha256 && jobDry.pid === job0.pid && afterDry.links.current === before.links.current && !existsSync(join(L.runtimeRoot, SHA)), { jobDry, links: afterDry.links });

  const hop1 = await rollout([SHA]);
  const afterHop1 = hostState(pids);
  const job1 = await jobState();
  record({ step: "hop1", ms: hop1.ms, code: hop1.code, steps: hop1.stepsText, result: hop1.result && { route: hop1.result.route, result: hop1.result.result, inventory: hop1.result.inventory }, host: afterHop1, job: job1, stderr: hop1.stderr });
  expect("hop1.first_hop_route", hop1.code === 0 && hop1.result?.ok && /first hop/.test(hop1.result.route), { route: hop1.result?.route, steps: hop1.stepsText, stderr: hop1.stderr });
  expect("hop1.bees_kept", pids.every((p) => afterHop1.pids[p]) && hop1.result.result.adopted === 3 && hop1.result.result.stopped === 0 && /boot adopted=3 stopped=0/.test(hop1.result.result.bootAdopt), { pids: afterHop1.pids, result: { adopted: hop1.result.result.adopted, stopped: hop1.result.result.stopped, bootAdopt: hop1.result.result.bootAdopt } });
  expect("hop1.plist_through_launcher", afterHop1.programArguments[0] === join(L.runtimeRoot, "launch") && afterHop1.programArguments[1] === NODE && afterHop1.abandonProcessGroup && afterHop1.links.current === SHA && afterHop1.links.previous === OLD_SHA && afterHop1.marker === false, { programArguments: afterHop1.programArguments, abandonProcessGroup: afterHop1.abandonProcessGroup, links: afterHop1.links, marker: afterHop1.marker });
  expect("hop1.launchd_reloaded_job", job1.loaded && job1.running && job1.pid !== job0.pid && job1.pid === hop1.result.result.successor.pid && job1.path === realpathSync(L.plist), { job0, job1, successor: hop1.result.result.successor });
  expect("hop1.successor_runs_target", hop1.result.inventory.running === SHA && hop1.result.inventory.unitForm === "launcher" && hop1.result.result.probe?.canary?.beeId, { inventory: hop1.result.inventory, probe: hop1.result.result.probe });
  const mail1 = await mailLands(newEntry, idle[0].beeId, `mac-after-hop1-${Date.now()}`);
  expect("hop1.mail_delivered", mail1.ok, { mail1 });
  const again = await rollout([SHA]);
  expect("hop1.idempotent", again.code === 0 && again.result?.changed === false && (await jobState()).pid === job1.pid, { steps: again.stepsText });

  const back = await rollout(["--rollback"]);
  const afterBack = hostState(pids);
  const jobBack = await jobState();
  record({ step: "rollback", ms: back.ms, code: back.code, steps: back.stepsText, result: back.result, host: afterBack, job: jobBack, stderr: back.stderr });
  expect("rollback.plist_and_entry_exact", back.code === 0 && back.result?.ok && afterBack.plistSha256 === before.plistSha256 && afterBack.links.current === before.links.current && afterBack.links.previous === null, { plist: [before.plistSha256, afterBack.plistSha256], links: afterBack.links });
  expect("rollback.old_build_under_launchd_bees_kept", jobBack.loaded && jobBack.pid !== job1.pid && back.result.rolledBackTo === OLD_SHA && back.result.adopted === 3 && pids.every((p) => afterBack.pids[p]), { jobBack, result: back.result, pids: afterBack.pids });
  const mailBack = await mailLands(oldEntry, idle[1].beeId, `mac-after-rollback-${Date.now()}`);
  expect("rollback.mail_delivered", mailBack.ok, { mailBack });

  const hop1b = await rollout([SHA]);
  const afterHop1b = hostState(pids);
  const job1b = await jobState();
  record({ step: "hop1.again", ms: hop1b.ms, code: hop1b.code, steps: hop1b.stepsText, host: afterHop1b, job: job1b, stderr: hop1b.stderr });
  expect("hop1.again_after_rollback", hop1b.code === 0 && hop1b.result?.ok && hop1b.result.result.adopted === 3 && hop1b.result.result.stopped === 0 && pids.every((p) => afterHop1b.pids[p]) && afterHop1b.links.current === SHA && job1b.pid === hop1b.result.result.successor.pid, { adopted: hop1b.result?.result?.adopted, pids: afterHop1b.pids, links: afterHop1b.links, job1b });
  const mail2 = await mailLands(newEntry, idle[2].beeId, `mac-after-rehop-${Date.now()}`);
  expect("hop1.again.mail_delivered", mail2.ok, { mail2 });
  record({ step: "lab.done", pass: true });
} catch (error) {
  exitCode = 1;
  record({ step: "lab.error", message: error instanceof Error ? error.message : String(error) });
} finally {
  const out = await launchctl(["bootout", `gui/${UID}/${LABEL}`]);
  const until = Date.now() + 30_000;
  while ((await jobState()).loaded && Date.now() < until) await sleep(100);
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  let leftovers = [];
  try { leftovers = execFileSync("pgrep", ["-f", root]).toString().split("\n").filter(Boolean).map(Number).filter((p) => p !== process.pid); } catch {}
  for (const pid of leftovers) { try { process.kill(pid, "SIGKILL"); } catch {} }
  const save = join(here, `${NAME}-logs`);
  mkdirSync(save, { recursive: true });
  for (const [from, to] of [[join(L.dataDir, "hived.log"), "hived.log"], [L.plist, "unit.plist"]]) { try { writeFileSync(join(save, to), readFileSync(from)); } catch {} }
  record({ step: "lab.cleanup", bootout: out.code, jobLoaded: (await jobState()).loaded, killedBees: pids.length, killedLeftovers: leftovers.length, logs: save, kept: Boolean(opt.keep) });
  if (!opt.keep) rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
