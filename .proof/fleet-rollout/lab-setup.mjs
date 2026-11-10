// Host side of the fleet-rollout lab: builds one scratch node under --root with its own data dir,
// runtime root, unit dir, launcher-free Apiary-style unit, a PATH-shimmed systemctl and a Node
// supervisor that plays systemd (SIGTERM the main pid only, re-exec whatever ExecStart the unit
// names, Restart on non-zero exit). Nothing here touches ~/.hive, ~/.config or a real service manager.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const command = argv.shift();
const opt = {};
for (let i = 0; i < argv.length; i += 1) { if (argv[i].startsWith("--")) { const k = argv[i].slice(2); const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true; opt[k] = v; } }
const need = (k) => { if (opt[k] === undefined) throw new Error(`--${k} required`); return opt[k]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const cmdline = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); } catch { return ""; } };
const out = (value) => console.log(JSON.stringify(value));
const LABEL = "hb.fleet.lab";

function layout(root) {
  return { root, dataDir: join(root, "v2"), runtimeRoot: join(root, "runtime"), units: join(root, "units"), bin: join(root, "bin"), unit: join(root, "units", `${LABEL}.service`), state: join(root, "service.json"), conf: join(root, "service.conf.json"), systemctlLog: join(root, "systemctl.log"), supervisorLog: join(root, "supervisor.log") };
}

const SUPERVISOR = `
import { spawn } from "node:child_process";
import { appendFileSync, openSync, readFileSync, writeFileSync } from "node:fs";
const [state, conf, logPath, unitPath] = process.argv.slice(2);
const baseEnv = (() => { try { return JSON.parse(readFileSync(state.replace(/service\.json$/, "env.json"), "utf8")); } catch { return process.env; } })();
const log = (line) => appendFileSync(logPath, new Date().toISOString() + " " + line + "\\n");
const read = () => { try { return JSON.parse(readFileSync(state, "utf8")); } catch { return { mainPid: null, starts: [] }; } };
const config = () => { try { return JSON.parse(readFileSync(conf, "utf8")); } catch { return { startDelayMs: 0 }; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokens = (line) => { const t = []; let i = 0; while (i < line.length) { while (i < line.length && /\\s/.test(line[i])) i += 1; if (i >= line.length) break; let s = ""; const qu = line[i] === '"' ? '"' : null; if (qu) { i += 1; while (i < line.length && line[i] !== qu) { if (line[i] === "\\\\" && i + 1 < line.length) { s += line[i + 1]; i += 2; continue; } s += line[i]; i += 1; } i += 1; } else while (i < line.length && !/\\s/.test(line[i])) { s += line[i]; i += 1; } t.push(s); } return t; };
const unit = () => { const text = readFileSync(unitPath, "utf8"); const exec = tokens(/^ExecStart=(.*)$/m.exec(text)[1]); const env = {}; for (const m of text.matchAll(/^Environment=(.*)$/gm)) for (const tok of tokens(m[1])) { const i = tok.indexOf("="); env[tok.slice(0, i)] = tok.slice(i + 1); } const outPath = /^StandardOutput=append:(.*)$/m.exec(text)?.[1]; return { exec, env, outPath }; };
const current = read();
if (current.mainPid && alive(current.mainPid)) {
  log("stop: SIGTERM main pid " + current.mainPid + " (KillMode=process: only the main pid)");
  process.kill(current.mainPid, "SIGTERM");
  const until = Date.now() + 30000;
  while (alive(current.mainPid) && Date.now() < until) await sleep(20);
  log("stop: main pid " + current.mainPid + " " + (alive(current.mainPid) ? "STILL ALIVE" : "gone"));
}
let starts = current.starts ?? [];
if (process.argv[6] === "stop-only") { writeFileSync(state, JSON.stringify({ mainPid: null, starts })); process.exit(0); }
const delay = config().startDelayMs ?? 0;
if (delay > 0) { log("start latency " + delay + " ms"); await sleep(delay); }
for (let attempt = 0; attempt < 12; attempt += 1) {
  const u = unit();
  const fd = openSync(u.outPath, "a");
  const child = spawn(u.exec[0], u.exec.slice(1), { env: { ...baseEnv, ...u.env }, stdio: ["ignore", fd, fd], detached: true });
  starts.push({ pid: child.pid, at: Date.now(), exec: u.exec.slice(0, 2) });
  writeFileSync(state, JSON.stringify({ mainPid: child.pid, starts }));
  log("start: pid " + child.pid + " (start #" + starts.length + ") exec " + JSON.stringify(u.exec));
  const code = await new Promise((r) => child.on("exit", (c, s) => r(c ?? ("signal " + s))));
  log("exit: pid " + child.pid + " code " + code);
  if (code === 0) { writeFileSync(state, JSON.stringify({ mainPid: null, starts })); break; }
  log("Restart: RestartSec 0.3");
  await sleep(300);
}
`;

function systemctlShim(L) {
  return `#!/bin/sh
echo "systemctl $*" >> "${L.systemctlLog}"
NODE="${process.execPath}"
STATE="${L.state}"; CONF="${L.conf}"; SUP="${L.supervisorLog}"; UNIT="${L.unit}"
mainpid() { "$NODE" -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=s.mainPid;if(p){process.kill(p,0);console.log(p)}else console.log(0)}catch{console.log(0)}' "$STATE"; }
starts() { "$NODE" -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Math.max(0,(s.starts||[]).length-1))}catch{console.log(0)}' "$STATE"; }
case "$*" in
  "--user daemon-reload") exit 0 ;;
  "--user reset-failed ${LABEL}.service") exit 0 ;;
  "--user restart --no-block ${LABEL}.service"|"--user start ${LABEL}.service")
    setsid "$NODE" "${join(L.bin, "supervisor.mjs")}" "$STATE" "$CONF" "$SUP" "$UNIT" </dev/null >>"$SUP.out" 2>&1 &
    exit 0 ;;
  "--user restart ${LABEL}.service")
    OLD=$(mainpid)
    setsid "$NODE" "${join(L.bin, "supervisor.mjs")}" "$STATE" "$CONF" "$SUP" "$UNIT" </dev/null >>"$SUP.out" 2>&1 &
    i=0; while [ $i -lt 400 ]; do NEW=$(mainpid); if [ "$NEW" != "0" ] && [ "$NEW" != "$OLD" ]; then exit 0; fi; sleep 0.1; i=$((i+1)); done
    exit 0 ;;
  "--user stop ${LABEL}.service")
    "$NODE" "${join(L.bin, "supervisor.mjs")}" "$STATE" "$CONF" "$SUP" "$UNIT" stop-only; exit 0 ;;
  "--user is-active ${LABEL}.service") if [ "$(mainpid)" != "0" ]; then echo active; exit 0; else echo inactive; exit 3; fi ;;
  "--user show ${LABEL}.service "*)
    P=$(mainpid); EXEC=$(sed -n 's/^ExecStart=//p' "$UNIT" | head -1); A0=$(printf '%s' "$EXEC" | sed 's/^"\\([^"]*\\)".*/\\1/')
    echo "MainPID=$P"; if [ "$P" != "0" ]; then echo "ActiveState=active"; echo "SubState=running"; else echo "ActiveState=inactive"; echo "SubState=dead"; fi
    echo "KillMode=$(sed -n 's/^KillMode=//p' "$UNIT" | head -1)"; echo "NRestarts=$(starts)"; echo "TasksCurrent=0"
    echo "ExecStart={ path=$A0 ; argv[]=$(printf '%s' "$EXEC" | tr -d '"') ; ignore_errors=no }"
    exit 0 ;;
esac
echo "systemctl shim: unhandled: $*" >&2
exit 1
`;
}

function apiaryUnit(L, node, entry, pathEnv) {
  const nodeSha = createHash("sha256").update(readFileSync(node)).digest("hex");
  const version = execFileSync(node, ["--version"]).toString().trim().replace(/^v/, "");
  return `[Unit]
Description=Honeybee v2 hive daemon (${LABEL})

[Service]
KillMode=process
Type=simple
ExecStart="${node}" "${entry}" "v2" "daemon" "run" "--data-dir" "${L.dataDir}"
Environment="HIVE_NODE_PATH=${node}"
Environment="HIVE_NODE_VERSION=${version}"
Environment="HIVE_NODE_SHA256=${nodeSha}"
Environment="HIVE_V2_DATA_DIR=${L.dataDir}"
Environment="PATH=${pathEnv}"
Restart=always
RestartSec=2
StandardOutput=append:${L.dataDir}/hived.log
StandardError=append:${L.dataDir}/hived.log

[Install]
WantedBy=default.target
`;
}

async function cli(node, entry, dataDir, args, env = process.env) {
  return new Promise((resolveRun) => {
    const child = spawn(node, [entry, ...args, "--data-dir", dataDir], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}
const lastJson = (text) => { const line = text.trim().split("\n").filter((l) => l.startsWith("{")).at(-1); try { return line ? JSON.parse(line) : null; } catch { return null; } };

async function setup() {
  const root = resolve(need("root"));
  const oldDir = resolve(need("old"));
  const node = need("node");
  const bees = Number(opt.bees ?? 3);
  const repo = resolve(need("repo"));
  const L = layout(root);
  for (const d of [L.dataDir, L.runtimeRoot, L.units, L.bin, join(root, "tmp"), join(root, "cells"), join(root, "home")]) mkdirSync(d, { recursive: true });
  const hash = basename(resolve(oldDir, "..", "..", ".."));
  const apiaryBase = join(root, "apiary", "honeybee-runtime", hash);
  const honeybee = join(apiaryBase, "lib", "node_modules", "honeybee");
  mkdirSync(dirname(honeybee), { recursive: true });
  execFileSync("cp", ["-a", oldDir, honeybee]);
  mkdirSync(join(apiaryBase, "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/honeybee/dist/cli.js", join(apiaryBase, "bin", "hive"));
  symlinkSync(honeybee, join(L.runtimeRoot, "current"));
  const entry = join(honeybee, "dist", "cli.js");
  const pathEnv = `${L.bin}:${dirname(node)}:/usr/local/bin:/usr/bin:/bin`;
  writeFileSync(L.unit, apiaryUnit(L, node, entry, pathEnv));
  writeFileSync(join(L.bin, "supervisor.mjs"), SUPERVISOR);
  writeFileSync(join(L.bin, "systemctl"), systemctlShim(L), { mode: 0o755 });
  writeFileSync(L.conf, JSON.stringify({ startDelayMs: Number(opt["start-delay"] ?? 0) }));
  writeFileSync(L.systemctlLog, "");
  writeFileSync(join(L.dataDir, "config.json"), JSON.stringify({ naming: { auto: false }, cells: { root: join(root, "cells"), retention: { enabled: false } }, agents: { stub: { command: node, args: [join(repo, "v2", "driver-hsr", "test-agent", "agent.mjs")], adapter: "stub" } } }));
  const env = { ...process.env, PATH: pathEnv, HIVE_V2_SERVICE_DIR: L.units, HIVE_V2_SERVICE_LABEL: LABEL, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1", TMPDIR: join(root, "tmp"), NO_COLOR: "1", HIVE_CLAUDE_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage", HIVE_CLAUDE_PROFILE_URL: "http://127.0.0.1:9/api/oauth/profile", HIVE_CLAUDE_OAUTH_TOKEN_URL: "http://127.0.0.1:9/v1/oauth/token", HIVE_CODEX_OAUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token", HIVE_GROK_OAUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token", HIVE_TEST_META_URL: "http://127.0.0.1:9" };
  writeFileSync(join(root, "env.json"), JSON.stringify(env));
  const started = Date.now();
  execFileSync(join(L.bin, "systemctl"), ["--user", "start", `${LABEL}.service`], { env });
  let info = null;
  while (Date.now() - started < 120_000) {
    if (existsSync(join(L.dataDir, "hived.endpoint.json"))) { const r = await cli(node, entry, L.dataDir, ["deploy-info", "--json"], env); info = lastJson(r.stdout); if (info) break; }
    await sleep(200);
  }
  if (!info) throw new Error(`lab daemon did not answer: ${readFileSync(L.supervisorLog, "utf8").slice(-1500)}`);
  const beeIds = [];
  for (let i = 1; i <= bees; i += 1) {
    const r = await cli(node, entry, L.dataDir, ["spawn", `lab-bee-${i}`, "--agent", "stub", "--cwd", root, "--json"], env);
    const j = lastJson(r.stdout);
    const id = j?.beeId ?? j?.id ?? j?.bee?.id;
    if (!id) throw new Error(`spawn failed: ${r.stdout.slice(-500)} ${r.stderr.slice(-500)}`);
    beeIds.push(id);
  }
  const idle = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && idle.length < beeIds.length) {
    const r = await cli(node, entry, L.dataDir, ["list", "--json"], env);
    const list = lastJson(r.stdout);
    idle.length = 0;
    for (const v of list?.views ?? []) if (beeIds.includes(v.bee.id) && v.runtime?.state === "idle") idle.push({ beeId: v.bee.id, name: v.bee.name, generation: v.runtime.generation, pid: v.runtime.pid });
    if (idle.length < beeIds.length) await sleep(300);
  }
  if (idle.length < beeIds.length) throw new Error(`only ${idle.length} of ${beeIds.length} stub bees reached idle`);
  const state = JSON.parse(readFileSync(L.state, "utf8"));
  out({ root, dataDir: L.dataDir, runtimeRoot: L.runtimeRoot, unit: L.unit, entry, honeybee, hash, mainPid: state.mainPid, daemonPid: info.pid ?? null, running: info.identity?.sourceRevision ?? null, protocol: info.protocol, bees: idle, bootMs: Date.now() - started });
}

async function makeArtifact() {
  const from = resolve(need("from")), sha = need("sha"), outDir = resolve(need("out"));
  const src = JSON.parse(readFileSync(join(from, "manifest.json"), "utf8"));
  const work = join(outDir, ".work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("tar", ["-xzf", join(from, src.tarball), "-C", work]);
  const identityPath = join(work, "dist", "build-identity.json");
  const identity = { ...JSON.parse(readFileSync(identityPath, "utf8")), sourceRevision: sha, version: `0.0.1-lab.${sha.slice(0, 12)}` };
  writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  if (opt.break) writeFileSync(join(work, "dist", "cli.js"), "#!/usr/bin/env node\nprocess.stderr.write('lab: this build exits at boot\\n');\nprocess.exit(3);\n");
  const manifest = { ...src, sha, identity, tarball: `honeybee-runtime-${sha}.tar.gz`, builtAt: new Date().toISOString() };
  writeFileSync(join(work, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(outDir, { recursive: true });
  const tarball = join(outDir, manifest.tarball);
  execFileSync("tar", ["-czf", tarball, "-C", work, ...readdirSync(work).sort()]);
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sum = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  writeFileSync(join(outDir, "SHA256SUMS"), `${sum(tarball)}  ${basename(tarball)}\n${sum(join(outDir, "manifest.json"))}  manifest.json\n`);
  rmSync(work, { recursive: true, force: true });
  out({ out: outDir, sha, tarball, broken: Boolean(opt.break) });
}

async function status() {
  const root = resolve(need("root"));
  const L = layout(root);
  const pids = String(opt.pids ?? "").split(",").filter(Boolean).map(Number);
  const state = JSON.parse(readFileSync(L.state, "utf8"));
  const calls = readFileSync(L.systemctlLog, "utf8").split("\n").filter(Boolean);
  const unitText = readFileSync(L.unit, "utf8");
  const links = {};
  for (const name of ["current", "previous"]) { try { links[name] = execFileSync("readlink", [join(L.runtimeRoot, name)]).toString().trim(); } catch { links[name] = null; } }
  const daemonLog = existsSync(join(L.dataDir, "hived.log")) ? readFileSync(join(L.dataDir, "hived.log"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).op; } catch { return l; } }) : [];
  out({ mainPid: state.mainPid, mainAlive: state.mainPid ? alive(state.mainPid) : false, starts: state.starts.length, pids: Object.fromEntries(pids.map((p) => [p, alive(p)])), systemctl: calls, unitExecStart: /^ExecStart=(.*)$/m.exec(unitText)?.[1] ?? null, unitSha256: createHash("sha256").update(unitText).digest("hex"), links, marker: existsSync(join(L.runtimeRoot, "handover.json")), rollbackFile: existsSync(join(L.runtimeRoot, "rollback.json")) ? JSON.parse(readFileSync(join(L.runtimeRoot, "rollback.json"), "utf8")) : null, installed: existsSync(L.runtimeRoot) ? readdirSync(L.runtimeRoot).filter((n) => /^[0-9a-f]{40}$/.test(n)) : [], bootLines: daemonLog.filter((op) => /^(daemon\.started|boot\.adopt|boot\.handover|boot\.rollback|runtime\.activate|boot\.handover_marker_removed)/.test(op)).slice(-40) });
}

async function teardown() {
  const root = resolve(need("root"));
  const L = layout(root);
  let state = { mainPid: null };
  try { state = JSON.parse(readFileSync(L.state, "utf8")); } catch {}
  if (state.mainPid && alive(state.mainPid)) { process.kill(state.mainPid, "SIGTERM"); const until = Date.now() + 30000; while (alive(state.mainPid) && Date.now() < until) await sleep(50); }
  let leftovers = [];
  try { leftovers = execFileSync("pgrep", ["-f", root]).toString().split("\n").filter(Boolean).map(Number).filter((p) => p !== process.pid && !cmdline(p).includes("lab-setup.mjs")); } catch {}
  for (const pid of leftovers) { try { process.kill(pid, "SIGKILL"); } catch {} }
  if (opt.save) {
    mkdirSync(opt.save, { recursive: true });
    for (const [from, to] of [[join(L.dataDir, "hived.log"), "hived.log"], [L.supervisorLog, "supervisor.log"], [L.systemctlLog, "systemctl.log"], [L.unit, "unit.service"]]) { try { writeFileSync(join(opt.save, to), readFileSync(from)); } catch {} }
  }
  if (!opt.keep) rmSync(root, { recursive: true, force: true });
  out({ root, stoppedMainPid: state.mainPid, killedLeftovers: leftovers.length, kept: Boolean(opt.keep) });
}

const commands = { setup, "make-artifact": makeArtifact, status, teardown };
if (!commands[command]) { console.error("usage: lab-setup.mjs setup|make-artifact|status|teardown ..."); process.exit(2); }
await commands[command]();
