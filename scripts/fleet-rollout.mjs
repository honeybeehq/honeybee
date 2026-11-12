#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_LABEL = "dev.honeybee.hive.v2";
const LAB_LABEL = "hb.fleet.lab";
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const SUCCESSOR_WAIT_S = 180;

const USAGE = `usage:
  node scripts/fleet-rollout.mjs <[user@]host|local> <sha> [--artifact <dir>|<host>:<dir>] [--set cells.retention.<key>=<json>]... [--dry-run] [--no-probe] [--allow-low-disk] [--json]
    --set writes the key into the host's config.json through the new build's own "hive config set" (atomic, 0600, every other key kept, the file never printed)
    after the install and before the activation, so the successor daemon boots with it; the plan prints the retention mode the host will have
  node scripts/fleet-rollout.mjs <[user@]host> --inventory [--json]
  node scripts/fleet-rollout.mjs <[user@]host> --rollback [--dry-run] [--force-store] [--json]
  lab only: --lab-root <dir on the host>   (scratch data dir, runtime root, unit dir, PATH shim; never the node's own)`;

function parseArgs(argv) {
  const o = { host: null, sha: null, artifact: null, dryRun: false, probe: true, allowLowDisk: false, json: false, inventory: false, rollback: false, labRoot: null, forceStore: false, sets: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value\n${USAGE}`); i += 1; return v; };
    if (a === "--artifact") o.artifact = value();
    else if (a === "--set") {
      const v = value();
      const eq = v.indexOf("=");
      const m = eq > 0 ? /^cells\.retention\.([A-Za-z]+)$/.exec(v.slice(0, eq)) : null;
      if (!m) throw new Error(`--set takes cells.retention.<key>=<json value>, got ${v}\n${USAGE}`);
      let parsed;
      try { parsed = JSON.parse(v.slice(eq + 1)); } catch { parsed = v.slice(eq + 1); }
      o.sets.push({ key: m[1], value: parsed, raw: v.slice(eq + 1) });
    }
    else if (a === "--lab-root") o.labRoot = value();
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--no-probe") o.probe = false;
    else if (a === "--allow-low-disk") o.allowLowDisk = true;
    else if (a === "--force-store") o.forceStore = true;
    else if (a === "--json") o.json = true;
    else if (a === "--inventory") o.inventory = true;
    else if (a === "--rollback") o.rollback = true;
    else if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    else if (a.startsWith("-")) throw new Error(`unknown flag ${a}\n${USAGE}`);
    else positional.push(a);
  }
  o.host = positional[0] ?? null;
  o.sha = positional[1] ?? null;
  if (!o.host) throw new Error(USAGE);
  if (o.labRoot !== null && !o.labRoot.startsWith("/")) throw new Error("--lab-root must be absolute");
  if (!o.inventory && !o.rollback) {
    if (!o.sha || !SHA.test(o.sha)) throw new Error(`a full 40-hex sha is required\n${USAGE}`);
  }
  return o;
}

const options = parseArgs(process.argv.slice(2));
const steps = [];
const findings = [];
const say = (line) => { if (!options.json) console.log(line); };
const step = (name, detail) => { steps.push({ at: new Date().toISOString(), step: name, ...(typeof detail === "string" ? { message: detail } : detail) }); say(`[${name}] ${typeof detail === "string" ? detail : detail?.message ?? JSON.stringify(detail)}`); };
const fail = (code, message, detail = {}) => { const error = new Error(message); error.code = code; error.detail = detail; throw error; };
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/hb-fleet-rollout-%C", "-o", "ControlPersist=120"];

function labPrelude() {
  if (!options.labRoot) return "";
  return `export PATH=${q(join(options.labRoot, "bin"))}:"$PATH" HIVE_V2_SERVICE_DIR=${q(join(options.labRoot, "units"))} HIVE_V2_SERVICE_LABEL=${q(LAB_LABEL)}\n`;
}

const LOCAL_HOST = "local";

async function remote(script, { timeoutMs = 120_000, allowFailure = false } = {}) {
  const child = options.host === LOCAL_HOST ? spawn("sh", ["-s"], { stdio: ["pipe", "pipe", "pipe"] }) : spawn("ssh", [...SSH, options.host, "sh", "-s"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdin.end(`${labPrelude()}${script}\n`);
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise((r) => child.on("close", (c) => r(c ?? 1)));
  clearTimeout(timer);
  if (code !== 0 && !allowFailure) fail("ssh_failed", `remote command on ${options.host} exited ${code}: ${stderr.trim().slice(-800) || stdout.trim().slice(-800)}`, { script: script.slice(0, 400) });
  return { code, stdout, stderr };
}

async function scpTo(localPaths, remoteDir) {
  if (options.host === LOCAL_HOST) { await execFileAsync("cp", [...localPaths, `${remoteDir}/`]); return; }
  await execFileAsync("scp", ["-q", ...SSH, ...localPaths, `${options.host}:${remoteDir}/`], { maxBuffer: 1024 * 1024 });
}

const kv = (text) => Object.fromEntries(text.split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const b64 = (s) => (s && s !== "-" ? Buffer.from(s, "base64").toString("utf8") : null);
const json = (text) => { const line = text.trim().split("\n").filter((l) => l.startsWith("{")).at(-1); if (!line) return null; try { return JSON.parse(line); } catch { return null; } };

function unitTokens(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i += 1;
    if (i >= line.length) break;
    let token = "";
    const quote = line[i] === '"' || line[i] === "'" ? line[i] : null;
    if (quote) {
      i += 1;
      while (i < line.length && line[i] !== quote) { if (line[i] === "\\" && i + 1 < line.length) { token += line[i + 1]; i += 2; continue; } token += line[i]; i += 1; }
      i += 1;
    } else while (i < line.length && !/\s/.test(line[i])) { token += line[i]; i += 1; }
    tokens.push(token);
  }
  return tokens;
}

const xmlUnescape = (s) => s.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

function parseUnit(contents, platform) {
  if (platform === "darwin") {
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(contents);
    const exec = args ? [...args[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => xmlUnescape(m[1])) : null;
    const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(contents);
    const env = {};
    if (envBlock) for (const m of envBlock[1].matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) env[xmlUnescape(m[1])] = xmlUnescape(m[2]);
    return { exec, env, killMode: null, restart: null, abandonProcessGroup: /<key>AbandonProcessGroup<\/key>\s*<true\/>/.test(contents) };
  }
  const exec = /^ExecStart=[-@+!:]*(.*)$/m.exec(contents);
  const env = {};
  for (const m of contents.matchAll(/^Environment=(.*)$/gm)) for (const token of unitTokens(m[1])) { const i = token.indexOf("="); if (i > 0) env[token.slice(0, i)] = token.slice(i + 1); }
  return { exec: exec ? unitTokens(exec[1]) : null, env, killMode: /^KillMode=(.*)$/m.exec(contents)?.[1] ?? null, restart: /^Restart=(.*)$/m.exec(contents)?.[1] ?? null, abandonProcessGroup: null };
}

function describeExec(exec) {
  if (!exec || exec.length < 2) return { form: "unknown", interpreter: null, entry: null, runtimeDir: null, dataDir: null };
  const dataDirAt = exec.indexOf("--data-dir");
  const dataDir = dataDirAt >= 0 ? exec[dataDirAt + 1] ?? null : null;
  if (basename(exec[0]) === "launch") return { form: "launcher", launcher: exec[0], interpreter: exec[1], entry: `${resolve(exec[0], "..", "current")}/dist/cli.js`, runtimeDir: null, dataDir };
  const m = /^(.*)[/\\]dist[/\\]cli\.js$/.exec(exec[1]);
  if (!m) return { form: "unknown", interpreter: exec[0], entry: exec[1], runtimeDir: null, dataDir };
  return { form: "explicit", interpreter: exec[0], entry: exec[1], runtimeDir: m[1], dataDir };
}

function layout(platform, home) {
  if (options.labRoot) return { home, dataDir: join(options.labRoot, "v2"), runtimeRoot: join(options.labRoot, "runtime"), unitDir: join(options.labRoot, "units"), label: LAB_LABEL, unitPath: join(options.labRoot, "units", `${LAB_LABEL}.${platform === "darwin" ? "plist" : "service"}`) };
  const unitDir = platform === "darwin" ? join(home, "Library", "LaunchAgents") : join(home, ".config", "systemd", "user");
  return { home, dataDir: join(home, ".hive", "v2"), runtimeRoot: join(home, ".hive", "runtime"), unitDir, label: DEFAULT_LABEL, unitPath: join(unitDir, `${DEFAULT_LABEL}.${platform === "darwin" ? "plist" : "service"}`) };
}

async function readFacts() {
  const stage1 = await remote(`
echo PLATFORM=$(uname -s); echo ARCH=$(uname -m); echo HOME_DIR=$HOME; echo USER_NAME=$(id -un); echo UID_NUM=$(id -u)
LAB=${q(options.labRoot ?? "")}
if [ -n "$LAB" ]; then DATA="$LAB/v2"; R="$LAB/runtime"; U="$LAB/units"; L=${q(LAB_LABEL)}; else DATA="$HOME/.hive/v2"; R="$HOME/.hive/runtime"; if [ "$(uname -s)" = Darwin ]; then U="$HOME/Library/LaunchAgents"; else U="$HOME/.config/systemd/user"; fi; L=${q(DEFAULT_LABEL)}; fi
if [ "$(uname -s)" = Darwin ]; then UNIT="$U/$L.plist"; else UNIT="$U/$L.service"; fi
echo UNIT_PATH=$UNIT
if [ -f "$UNIT" ]; then echo UNIT_B64=$(base64 < "$UNIT" | tr -d '\\n'); else echo UNIT_B64=-; fi
echo CURRENT_LINK=$(readlink "$R/current" 2>/dev/null || echo -)
echo PREVIOUS_LINK=$(readlink "$R/previous" 2>/dev/null || echo -)
echo LAUNCHER=$([ -x "$R/launch" ] && echo yes || echo no)
echo MARKER=$([ -f "$R/handover.json" ] && cat "$R/handover.json" | tr -d '\\n' || echo -)
echo ROLLBACK_FILE=$([ -f "$R/rollback.json" ] && cat "$R/rollback.json" | tr -d '\\n' || echo -)
echo INSTALLED=$(ls "$R" 2>/dev/null | grep -E '^[0-9a-f]{40}$' | tr '\\n' ',')
echo LAST_BACKUP=$(cat "$R/.fleet-rollout/last" 2>/dev/null || echo -)
if [ -f "$DATA/hived.endpoint.json" ]; then echo ENDPOINT=$(tr -d '\\n' < "$DATA/hived.endpoint.json"); else echo ENDPOINT=-; fi
PID=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$DATA/hived.endpoint.json" 2>/dev/null)
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo PID_ALIVE=yes; echo PID_ARGS=$(ps -o args= -p "$PID" | head -c 600); else echo PID_ALIVE=no; echo PID_ARGS=-; fi
if [ "$(uname -s)" = Linux ] && [ -n "$PID" ]; then echo ZOMBIES=$(ps -eo stat,ppid | awk -v p="$PID" '$1 ~ /^Z/ && $2==p' | wc -l | tr -d ' '); else echo ZOMBIES=-; fi
echo FREE_KB=$(df -Pk "$HOME" | tail -1 | awk '{print $4}')
if [ -f "$DATA/config.json" ]; then echo CONFIG_PRESENT=yes; else echo CONFIG_PRESENT=no; fi
echo LOG_BYTES=$(stat -c %s "$DATA/hived.log" 2>/dev/null || stat -f %z "$DATA/hived.log" 2>/dev/null || echo 0)
echo STORE_BYTES=$(stat -c %s "$DATA/core.sqlite3" 2>/dev/null || stat -f %z "$DATA/core.sqlite3" 2>/dev/null || echo 0)
if [ "$(uname -s)" = Linux ]; then echo SYSTEMD=$(systemctl --user show "$L.service" -p MainPID,ActiveState,SubState,KillMode,NRestarts,TasksCurrent 2>/dev/null | tr '\\n' ' '); echo SYSTEMD_EXEC=$(systemctl --user show "$L.service" -p ExecStart 2>/dev/null | head -c 400 | tr '\\n' ' '); else echo LAUNCHD=$(launchctl print gui/$(id -u)/$L 2>/dev/null | grep -E 'pid =|state =' | head -2 | tr '\\n' ' '); fi
`);
  if (process.env.FLEET_ROLLOUT_DEBUG) console.error(stage1.stdout.replace(/UNIT_B64=.*/, "UNIT_B64=<omitted>"), stage1.stderr);
  const f = kv(stage1.stdout);
  const platform = f.PLATFORM === "Darwin" ? "darwin" : f.PLATFORM === "Linux" ? "linux" : fail("unsupported_platform", `unsupported platform ${f.PLATFORM}`);
  const arch = f.ARCH === "x86_64" ? "x64" : f.ARCH === "arm64" || f.ARCH === "aarch64" ? "arm64" : f.ARCH;
  const target = `${platform}-${arch}`;
  const lay = layout(platform, f.HOME_DIR);
  const unitText = b64(f.UNIT_B64);
  const unit = unitText ? parseUnit(unitText, platform) : null;
  const exec = unit ? describeExec(unit.exec) : describeExec(null);
  const endpoint = f.ENDPOINT && f.ENDPOINT !== "-" ? JSON.parse(f.ENDPOINT) : null;
  const runningArgs = f.PID_ARGS && f.PID_ARGS !== "-" ? f.PID_ARGS.split(/\s+/) : [];
  const runningEntry = runningArgs.find((a) => a.endsWith("/dist/cli.js")) ?? null;
  const runningDir = runningEntry ? runningEntry.replace(/\/dist\/cli\.js$/, "") : null;
  const interpreter = exec.interpreter ?? runningArgs[0] ?? null;
  const facts = {
    host: options.host, platform, target, user: f.USER_NAME, uid: Number(f.UID_NUM), ...lay,
    unitText, unit, exec, unitInstalled: unitText !== null,
    currentLink: f.CURRENT_LINK === "-" ? null : f.CURRENT_LINK, previousLink: f.PREVIOUS_LINK === "-" ? null : f.PREVIOUS_LINK, launcher: f.LAUNCHER === "yes",
    marker: f.MARKER === "-" ? null : JSON.parse(f.MARKER), rollbackFile: f.ROLLBACK_FILE === "-" ? null : JSON.parse(f.ROLLBACK_FILE),
    installed: (f.INSTALLED ?? "").split(",").filter(Boolean), lastBackup: f.LAST_BACKUP === "-" ? null : f.LAST_BACKUP,
    endpoint, pidAlive: f.PID_ALIVE === "yes", runningEntry, runningDir, interpreter,
    zombies: f.ZOMBIES === "-" ? null : Number(f.ZOMBIES), freeBytes: Number(f.FREE_KB) * 1024, logBytes: Number(f.LOG_BYTES), storeBytes: Number(f.STORE_BYTES),
    serviceManager: f.SYSTEMD ?? f.LAUNCHD ?? null, systemdExec: f.SYSTEMD_EXEC ?? null,
    running: null, store: null, runtimeStatus: null, liveRuntimes: [], bees: null, hasActivate: false, hasRuntimeUpdate: false,
  };
  if (!facts.pidAlive || !runningEntry || !interpreter) return facts;
  const stage2 = await remote(`
NODE=${q(interpreter)}; ENTRY=${q(runningEntry)}; DATA=${q(lay.dataDir)}; DIR=${q(runningDir)}
echo NODE_VERSION=$("$NODE" --version 2>&1)
echo RETENTION=$("$NODE" -e 'const fs=require("node:fs");const p=process.argv[1];try{if(!fs.existsSync(p)){console.log(JSON.stringify({present:false,nodeKind:null,retention:null}));process.exit(0)}const c=JSON.parse(fs.readFileSync(p,"utf8"));const cells=c&&typeof c==="object"&&c.cells&&typeof c.cells==="object"?c.cells:{};console.log(JSON.stringify({present:true,nodeKind:c&&typeof c==="object"&&c.nodeKind!==undefined?c.nodeKind:null,retention:cells.retention&&typeof cells.retention==="object"?cells.retention:null}))}catch(e){console.log(JSON.stringify({present:true,error:String(e&&e.message||e)}))}' "$DATA/config.json" 2>&1 | tail -1)
echo ACTIVATE_IN_BUNDLE=$(grep -l 'runtime.activate' "$DIR"/dist/v2/cli*.js 2>/dev/null | wc -l | tr -d ' ')
echo BUNDLE_SCHEMA=$(grep -hoE '^(var|let|const) SCHEMA_VERSION[0-9]* = [0-9]+;$' "$DIR"/dist/v2/cli*.js 2>/dev/null | grep -oE '[0-9]+;$' | tr -d ';' | sort -u | tr '\\n' ',')
echo IDENTITY=$(tr -d '\\n ' < "$DIR/dist/build-identity.json" 2>/dev/null || echo -)
echo DEPLOY_INFO=$("$NODE" "$ENTRY" deploy-info --json --data-dir "$DATA" 2>/dev/null | tail -1)
echo RUNTIME_STATUS=$("$NODE" "$ENTRY" runtime status --json --data-dir "$DATA" 2>/dev/null | tail -1)
"$NODE" "$ENTRY" list --json --data-dir "$DATA" 2>/dev/null | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let s;try{s=JSON.parse(d)}catch{console.log("LIST=-");return}const live=[];let bees=0;for(const v of s.views||[]){bees+=1;const r=v.runtime;if(r&&r.state!=="stopped"&&r.pid!=null)live.push({beeId:r.beeId,name:v.bee&&v.bee.name,generation:r.generation,pid:r.pid,pidStartedAt:r.pidStartedAt,state:r.state,substrate:v.bee&&v.bee.substrate})}console.log("LIST="+JSON.stringify({bees,live}))})'
`, { timeoutMs: 180_000 });
  const g = kv(stage2.stdout);
  facts.nodeVersion = g.NODE_VERSION ?? null;
  facts.configPresent = f.CONFIG_PRESENT === "yes";
  facts.retention = g.RETENTION ? json(g.RETENTION) : null;
  facts.hasActivate = Number(g.ACTIVATE_IN_BUNDLE) > 0;
  facts.runningSchema = (g.BUNDLE_SCHEMA ?? "").split(",").filter(Boolean).map(Number);
  facts.runningIdentity = g.IDENTITY && g.IDENTITY !== "-" ? JSON.parse(g.IDENTITY) : null;
  const deployInfo = g.DEPLOY_INFO ? json(g.DEPLOY_INFO) : null;
  facts.running = deployInfo ? { sourceRevision: deployInfo.identity?.sourceRevision ?? null, protocol: deployInfo.protocol, daemonVersion: deployInfo.daemonVersion, nodeVersion: deployInfo.nodeVersion, capabilities: deployInfo.capabilities?.length ?? null, peercred: deployInfo.localSecurity?.peerCredentials?.state ?? null, nodeId: deployInfo.nodeId ?? null } : null;
  facts.hasRuntimeUpdate = Boolean(deployInfo?.capabilities?.includes("runtime.update.v1"));
  facts.runtimeStatus = g.RUNTIME_STATUS ? json(g.RUNTIME_STATUS) : null;
  facts.store = facts.runtimeStatus?.store ?? deployInfo?.store ?? null;
  const list = g.LIST && g.LIST !== "-" ? JSON.parse(g.LIST) : null;
  facts.bees = list?.bees ?? null;
  facts.liveRuntimes = list?.live ?? [];
  if (facts.store === null && facts.runningSchema.length === 1) facts.store = { schemaVersion: null, minReaderSchema: null, runningBuildSchema: facts.runningSchema[0] };
  return facts;
}

const fmtBytes = (n) => n == null ? "-" : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${n} B`;

/**
 * The retention mode and budget enforcement the host will run with after the
 * activation: config.json as it is, overlaid with every --set, resolved the
 * way cellRetentionOf does (mode is "plan" only when written so; budgetEnforce
 * defaults to true on satellites, false elsewhere). Unknown when the section
 * could not be read: the rollout refuses such a host.
 */
function retentionAfter(f) {
  const r = f.retention;
  if (!r || r.error) return { ok: false, reason: r?.error ? `config.json unreadable: ${r.error}` : "the retention section could not be read" };
  const written = { ...(r.retention ?? {}) };
  const sources = Object.fromEntries(Object.keys(written).map((k) => [k, "config"]));
  for (const s of options.sets) { written[s.key] = s.value; sources[s.key] = "--set"; }
  const nodeKind = r.nodeKind ?? "workstation";
  const mode = written.mode === "plan" ? "plan" : "apply";
  const modeSource = written.mode === undefined ? "default" : written.mode === "plan" || written.mode === "apply" ? sources.mode : `default (invalid value ${JSON.stringify(written.mode)} falls back)`;
  const enforceDefault = nodeKind === "satellite";
  const budgetEnforce = typeof written.budgetEnforce === "boolean" ? written.budgetEnforce : enforceDefault;
  const enforceSource = typeof written.budgetEnforce === "boolean" ? sources.budgetEnforce : "default";
  const enabled = typeof written.enabled === "boolean" ? written.enabled : true;
  return { ok: true, nodeKind, present: r.present, mode, modeSource, budgetEnforce, enforceSource, enabled, enabledSource: typeof written.enabled === "boolean" ? sources.enabled : "default", keysWritten: Object.keys(r.retention ?? {}) };
}

function describeRetention(a) {
  return `after activation this host runs retention mode=${a.mode} (${a.modeSource})${a.enabled ? "" : ", enabled=false"}; budgetEnforce=${a.budgetEnforce} (${a.enforceSource}); nodeKind ${a.nodeKind}; config.json ${a.present ? `has ${a.keysWritten.length} retention key(s): ${a.keysWritten.join(", ") || "none"}` : "absent"}` +
    (a.mode === "plan" ? " — scheduled passes plan only, no eviction until mode=apply" : " — scheduled passes EVICT (bundles first); set cells.retention.mode=plan to hold");
}

async function applyConfigSets(f, sha) {
  if (options.sets.length === 0) return;
  const cli = join(f.runtimeRoot, sha, "dist", "cli.js");
  const cmds = options.sets.map((s) => `${q(f.interpreter)} ${q(cli)} config set ${q(`cells.retention.${s.key}`)} ${q(s.raw)} --data-dir ${q(f.dataDir)}`);
  if (options.dryRun) { step("config", `DRY RUN would run on ${options.host} (the new build's own writer, after install, before activation):\n  ${cmds.join("\n  ")}`); return; }
  for (const cmd of cmds) {
    const r = await remote(cmd, { timeoutMs: 60_000, allowFailure: true });
    if (r.code !== 0) fail("config_set_failed", `hive config set failed on ${options.host}: ${(r.stdout + r.stderr).trim().slice(-600)}`);
    step("config", (r.stdout.trim().split("\n").pop() ?? "").slice(0, 300));
  }
  const after = await readFacts();
  const a = retentionAfter(after);
  if (!a.ok) fail("config_unverified", `retention could not be read back after hive config set: ${a.reason}`);
  for (const s of options.sets) {
    const got = after.retention?.retention?.[s.key];
    if (JSON.stringify(got) !== JSON.stringify(s.value)) fail("config_unverified", `cells.retention.${s.key} reads ${JSON.stringify(got)} after the write, expected ${JSON.stringify(s.value)}`);
  }
  step("config", `verified: ${describeRetention(a)}`);
}

function inventoryRow(f) {
  return {
    host: f.host, target: f.target, running: f.running?.sourceRevision ?? f.runningIdentity?.sourceRevision ?? null, protocol: f.running?.protocol ?? null,
    store: f.store ? `${f.store.schemaVersion ?? "?"}/${f.store.minReaderSchema ?? "none"}${f.store.runningBuildSchema ? ` (build schema ${f.store.runningBuildSchema})` : ""}` : null,
    unitForm: f.exec.form, killMode: f.unit?.killMode ?? null, restart: f.unit?.restart ?? null, nodePin: f.interpreter, nodeVersion: f.nodeVersion ?? null,
    hasActivate: f.hasActivate, hasRuntimeUpdate: f.hasRuntimeUpdate, currentLink: f.currentLink, installed: f.installed.length,
    liveRuntimes: f.liveRuntimes.length, bees: f.bees, pid: f.endpoint?.pid ?? null, zombies: f.zombies, free: fmtBytes(f.freeBytes), log: fmtBytes(f.logBytes), storeFile: fmtBytes(f.storeBytes),
    retention: (() => { const a = f.retention === undefined ? null : retentionAfter(f); return a == null ? null : a.ok ? `mode=${a.mode} (${a.modeSource}) budgetEnforce=${a.budgetEnforce} (${a.enforceSource}) nodeKind=${a.nodeKind}` : `unknown: ${a.reason}`; })(),
  };
}

function printInventory(f) {
  const row = inventoryRow(f);
  if (options.json) { console.log(JSON.stringify({ inventory: row, facts: { ...f, unitText: undefined } })); return; }
  for (const [k, v] of Object.entries(row)) console.log(`${k.padEnd(16)} ${v === null || v === undefined ? "-" : String(v)}`);
}

async function bundleSchemaOf(dir) {
  const bundleDir = join(dir, "dist", "v2");
  const names = readdirSync(bundleDir).filter((n) => n === "cli.js" || /^cli-chunk-[A-Z0-9]+\.js$/.test(n)).sort();
  const versions = names.flatMap((n) => [...readFileSync(join(bundleDir, n), "utf8").matchAll(/^(?:var|let|const) SCHEMA_VERSION\d* = (\d+);$/gm)].map((m) => Number(m[1])));
  return versions.length === 1 ? versions[0] : null;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function packFromInstalled(sha, outDir) {
  const installed = join(homedir(), ".hive", "runtime", sha);
  const manifestPath = join(installed, "manifest.json");
  if (!existsSync(join(installed, "dist", "cli.js")) || !existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.sha !== sha || manifest.identity?.sourceRevision !== sha) return null;
  const entries = readdirSync(installed).sort();
  const tarball = join(outDir, `honeybee-runtime-${sha}.tar.gz`);
  await execFileAsync("tar", ["-czf", tarball, "-C", installed, ...entries], { env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = [tarball, join(outDir, "manifest.json")].map((p) => `${sha256(p)}  ${basename(p)}`).join("\n");
  writeFileSync(join(outDir, "SHA256SUMS"), `${sums}\n`);
  return { dir: outDir, source: installed };
}

async function prepareArtifact(sha, target, scratch) {
  let dir = options.artifact;
  let source = dir;
  if (dir && /^[^/]+:/.test(dir)) {
    const local = join(scratch, "artifact");
    await execFileAsync("mkdir", ["-p", local]);
    const [h, p] = [dir.slice(0, dir.indexOf(":")), dir.slice(dir.indexOf(":") + 1)];
    await execFileAsync("scp", ["-q", ...SSH, `${h}:${p}/honeybee-runtime-${sha}.tar.gz`, `${h}:${p}/manifest.json`, `${h}:${p}/SHA256SUMS`, `${local}/`], { maxBuffer: 1024 * 1024 });
    dir = local;
  }
  if (!dir) {
    const hostTarget = `${process.platform}-${process.arch}`;
    if (target !== hostTarget) fail("artifact_missing", `no --artifact given and this machine is ${hostTarget}, not ${target}: build it on a ${target} host with "node scripts/build-runtime-artifact.mjs ${sha} --out <dir>" and pass --artifact <host>:<dir>`);
    const local = join(scratch, "artifact");
    await execFileAsync("mkdir", ["-p", local]);
    const packed = await packFromInstalled(sha, local);
    if (!packed) fail("artifact_missing", `no --artifact given and ~/.hive/runtime/${sha} is not an installed ${target} build of ${sha}: build it with "node scripts/build-runtime-artifact.mjs ${sha} --out <dir>"`);
    dir = local; source = `packed from ${packed.source}`;
  }
  const tarball = join(dir, `honeybee-runtime-${sha}.tar.gz`);
  const manifestPath = join(dir, "manifest.json");
  const sumsPath = join(dir, "SHA256SUMS");
  for (const p of [tarball, manifestPath, sumsPath]) if (!existsSync(p)) fail("artifact_invalid", `${p} is missing`);
  const sums = Object.fromEntries(readFileSync(sumsPath, "utf8").split("\n").filter(Boolean).map((l) => { const [h, n] = l.split(/\s+/); return [n, h]; }));
  for (const p of [tarball, manifestPath]) if (sums[basename(p)] !== sha256(p)) fail("artifact_digest_mismatch", `${basename(p)} does not match SHA256SUMS`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.sha !== sha) fail("artifact_invalid", `manifest is for ${manifest.sha}, not ${sha}`);
  const id = manifest.identity;
  if (!id || id.component !== "honeybee" || id.sourceRevision !== sha || id.dirty !== false) fail("artifact_invalid", `manifest identity is not a clean honeybee build of ${sha}`);
  if (id.target !== target) fail("target_mismatch", `artifact targets ${id.target}; ${options.host} is ${target}`);
  const unpacked = join(scratch, "unpacked");
  await execFileAsync("mkdir", ["-p", unpacked]);
  await execFileAsync("tar", ["-xzf", tarball, "-C", unpacked], { maxBuffer: 1024 * 1024 });
  const identity = JSON.parse(readFileSync(join(unpacked, "dist", "build-identity.json"), "utf8"));
  if (identity.sourceRevision !== sha || identity.target !== target || identity.dirty !== false) fail("artifact_invalid", "unpacked build-identity.json differs from the manifest");
  const stamp = JSON.parse(readFileSync(join(unpacked, "dist", ".build-stamp.json"), "utf8"));
  if (stamp.hash !== manifest.artifactHash) fail("artifact_invalid", `dist/.build-stamp.json hash ${stamp.hash} differs from manifest artifactHash ${manifest.artifactHash}`);
  for (const native of [join("dist", "v2", "peercred", target, "peercred.node"), join("dist", "v2", "delivery-file", target, "delivery-file.node")]) if (!existsSync(join(unpacked, native))) fail("artifact_invalid", `artifact has no ${native}`);
  const schema = await bundleSchemaOf(unpacked);
  if (schema === null) fail("schema_unknown", "artifact bundle carries no unambiguous SCHEMA_VERSION");
  const bytes = readFileSync(tarball).length;
  rmSync(unpacked, { recursive: true, force: true });
  return { dir, source, tarball, manifestPath, sumsPath, manifest, schema, bytes, gate: manifest.gate, tarballSha256: sums[basename(tarball)] };
}

function restartCommand(f) {
  if (f.platform === "linux") return `systemctl --user daemon-reload && systemctl --user restart ${f.label}.service`;
  return `launchctl bootout gui/${f.uid}/${f.label}; i=0; while launchctl print gui/${f.uid}/${f.label} >/dev/null 2>&1 && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done; launchctl bootstrap gui/${f.uid} ${q(f.unitPath)}`;
}

function preflight(f, sha, artifact) {
  const problems = [];
  if (!f.unitInstalled) problems.push(`no service unit at ${f.unitPath}`);
  if (f.exec.form === "unknown") problems.push(`unit ExecStart is neither an explicit dist/cli.js entry nor the launcher: ${JSON.stringify(f.unit?.exec)}`);
  if (f.exec.dataDir && f.exec.dataDir !== f.dataDir) problems.push(`unit names data dir ${f.exec.dataDir}, expected ${f.dataDir}`);
  if (f.platform === "linux" && f.unit?.killMode !== "process") problems.push(`unit KillMode is ${f.unit?.killMode ?? "unset"}, not process: a restart would kill every bee`);
  if (!f.pidAlive || !f.running) problems.push("no live hived answers deploy-info on this host");
  if (f.marker) problems.push(`a handover is already in flight: ${JSON.stringify(f.marker)}`);
  if (f.store === null) problems.push("the store schema could not be read from the running daemon");
  if (f.store?.minReaderSchema != null && f.store.minReaderSchema > artifact.schema) problems.push(`store needs a reader at schema ${f.store.minReaderSchema}; ${sha} is schema ${artifact.schema}`);
  if (f.store?.schemaVersion != null && f.store.schemaVersion > artifact.schema) problems.push(`store is schema ${f.store.schemaVersion}, newer than ${sha} (schema ${artifact.schema})`);
  if (f.store?.runningBuildSchema != null && f.store.runningBuildSchema > artifact.schema) problems.push(`running build writes schema ${f.store.runningBuildSchema}, newer than ${sha} (schema ${artifact.schema})`);
  if (!f.interpreter) problems.push("no node interpreter found in the unit");
  if (f.nodeVersion && !/^v(2[0-9]|[3-9][0-9])\./.test(f.nodeVersion)) problems.push(`node pin ${f.interpreter} is ${f.nodeVersion}; ${sha} needs ${artifact.manifest.engines.node}`);
  if (f.freeBytes < MIN_FREE_BYTES && !options.allowLowDisk) problems.push(`only ${fmtBytes(f.freeBytes)} free under ${f.home}; need ${fmtBytes(MIN_FREE_BYTES)} (pass --allow-low-disk to proceed)`);
  const degraded = f.liveRuntimes.filter((r) => r.state === "booting");
  if (degraded.length) problems.push(`${degraded.length} runtime(s) still booting; wait for them to settle`);
  return problems;
}

function alreadyThere(f, sha) {
  return f.running?.sourceRevision === sha && f.exec.form === "launcher" && f.currentLink === sha && !f.marker;
}

async function shipAndInstall(f, sha, artifact) {
  const incoming = join(f.runtimeRoot, ".incoming", sha);
  if (f.installed.includes(sha)) {
    const check = await remote(`R=${q(f.runtimeRoot)}; S=${q(sha)}; echo ID=$(tr -d '\\n ' < "$R/$S/dist/build-identity.json" 2>/dev/null || echo -); echo STAMP=$(tr -d '\\n ' < "$R/$S/dist/.build-stamp.json" 2>/dev/null || echo -)`);
    const c = kv(check.stdout);
    const id = c.ID !== "-" ? JSON.parse(c.ID) : null;
    const stamp = c.STAMP !== "-" ? JSON.parse(c.STAMP) : null;
    if (id?.sourceRevision === sha && id.target === f.target && stamp?.hash === artifact.manifest.artifactHash) { step("install", `runtime/${sha} is already installed with the artifact's bytes (stamp ${stamp.hash.slice(0, 12)})`); return "existing"; }
    fail("install_conflict", `runtime/${sha} exists on ${options.host} with different bytes (identity ${id?.sourceRevision ?? "?"}, stamp ${stamp?.hash ?? "?"}); remove it by hand before installing`);
  }
  if (options.dryRun) { step("install", `DRY RUN would scp ${basename(artifact.tarball)} (${fmtBytes(artifact.bytes)}), manifest.json and SHA256SUMS to ${options.host}:${incoming}, verify sums, unpack to ${f.runtimeRoot}/.stage.${sha}.<pid>, check build identity and stamp, then rename to ${f.runtimeRoot}/${sha}`); return "dry"; }
  await remote(`mkdir -p ${q(incoming)}`);
  const t0 = Date.now();
  await scpTo([artifact.tarball, artifact.manifestPath, artifact.sumsPath], incoming);
  step("ship", `copied ${fmtBytes(artifact.bytes)} to ${options.host}:${incoming} in ${Date.now() - t0} ms`);
  const r = await remote(`
set -e
R=${q(f.runtimeRoot)}; S=${q(sha)}; IN=${q(incoming)}; TARGET=${q(f.target)}; HASH=${q(artifact.manifest.artifactHash)}; TGZ=${q(artifact.tarballSha256)}
cd "$IN"
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS >/dev/null; else shasum -a 256 -c SHA256SUMS >/dev/null; fi
SUM=$( (sha256sum "honeybee-runtime-$S.tar.gz" 2>/dev/null || shasum -a 256 "honeybee-runtime-$S.tar.gz") | awk '{print $1}')
[ "$SUM" = "$TGZ" ] || { echo "tarball sha256 $SUM differs from $TGZ"; exit 3; }
STAGE="$R/.stage.$S.$$"; rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -xzf "honeybee-runtime-$S.tar.gz" -C "$STAGE"
ID=$(tr -d '\\n ' < "$STAGE/dist/build-identity.json")
case "$ID" in *"\\"sourceRevision\\":\\"$S\\""*) ;; *) echo "unpacked build identity is not $S: $ID"; rm -rf "$STAGE"; exit 3;; esac
case "$ID" in *"\\"target\\":\\"$TARGET\\""*) ;; *) echo "unpacked build targets another platform: $ID"; rm -rf "$STAGE"; exit 3;; esac
case "$ID" in *"\\"dirty\\":false"*) ;; *) echo "unpacked build is dirty: $ID"; rm -rf "$STAGE"; exit 3;; esac
STAMP=$(tr -d '\\n ' < "$STAGE/dist/.build-stamp.json")
case "$STAMP" in *"\\"hash\\":\\"$HASH\\""*) ;; *) echo "unpacked stamp $STAMP differs from manifest artifactHash $HASH"; rm -rf "$STAGE"; exit 3;; esac
[ -f "$STAGE/dist/v2/peercred/$TARGET/peercred.node" ] || { echo "no peercred native for $TARGET"; rm -rf "$STAGE"; exit 3; }
if [ -e "$R/$S" ]; then rm -rf "$STAGE"; echo "runtime/$S appeared while staging"; exit 3; fi
mv "$STAGE" "$R/$S"
rm -rf "$IN"; rmdir "$R/.incoming" 2>/dev/null || true
echo INSTALLED=new
`, { timeoutMs: 300_000, allowFailure: true });
  if (r.code !== 0) fail("install_failed", `install on ${options.host} failed: ${(r.stdout + r.stderr).trim().slice(-600)}`);
  step("install", `unpacked and verified ${sha} into ${f.runtimeRoot}/${sha} (identity ${f.target}, stamp ${artifact.manifest.artifactHash.slice(0, 12)})`);
  return "new";
}

async function backupBefore(f, sha) {
  const dir = join(f.runtimeRoot, ".fleet-rollout", new Date().toISOString().replace(/[:.]/g, "-"));
  if (options.dryRun) { step("backup", `DRY RUN would save the unit, current/previous link targets and the census to ${dir}`); return dir; }
  const unitB64 = Buffer.from(f.unitText).toString("base64");
  const state = { at: Date.now(), host: options.host, toSha: sha, unitPath: f.unitPath, currentLink: f.currentLink, previousLink: f.previousLink, runningSha: f.running.sourceRevision, runningEntry: f.runningEntry, runningDir: f.runningDir, interpreter: f.interpreter, unitForm: f.exec.form, store: f.store, census: f.liveRuntimes, pid: f.endpoint?.pid ?? null };
  await remote(`set -e; D=${q(dir)}; mkdir -p "$D"; echo ${q(unitB64)} | base64 --decode > "$D/unit.before"; cat > "$D/state.json" <<'EOF'
${JSON.stringify(state, null, 2)}
EOF
printf '%s' ${q(dir)} > ${q(join(f.runtimeRoot, ".fleet-rollout", "last"))}`);
  step("backup", `saved the unit and the pre-swap state to ${dir}`);
  return dir;
}

async function adoptUnit(f, sha) {
  const newEntry = join(f.runtimeRoot, sha, "dist", "cli.js");
  const unitPath = f.unit?.env?.PATH ?? null;
  const envParts = [`HOME=${q(f.home)}`, ...(unitPath ? [`PATH=${q(unitPath)}`] : []), ...Object.entries(f.unit?.env ?? {}).filter(([k]) => k.startsWith("XDG_")).map(([k, v]) => `${k}=${q(v)}`)];
  const cmd = `env -u HIVE_NODE_PATH -u HIVE_NODE_VERSION -u HIVE_NODE_SHA256 -u HIVE_CELL ${envParts.join(" ")} ${q(f.interpreter)} ${q(newEntry)} daemon install --data-dir ${q(f.dataDir)} --json`;
  if (f.exec.form === "launcher" && f.currentLink && SHA.test(f.currentLink)) { step("adopt", `unit already runs through the launcher (${f.exec.launcher}); current -> ${f.currentLink}`); return { adopted: null }; }
  if (options.dryRun) { step("adopt", `DRY RUN would run on ${options.host}: ${cmd}\n  expecting: runtime/${f.running.sourceRevision} copied from ${f.exec.runtimeDir ?? f.currentLink}, current -> ${f.running.sourceRevision}, launcher at ${f.runtimeRoot}/launch, ExecStart through it (interpreter ${f.interpreter}), KillMode=process, Restart=on-failure, PATH kept${f.platform === "linux" ? ", one systemctl --user daemon-reload" : ""}`); return { adopted: "dry" }; }
  const r = await remote(cmd, { timeoutMs: 300_000, allowFailure: true });
  const out = json(r.stdout);
  if (r.code !== 0 || !out) fail("adopt_failed", `hive daemon install on ${options.host} failed: ${(r.stdout + r.stderr).trim().slice(-800)}`);
  const after = await readFacts();
  const expectedExec = [join(f.runtimeRoot, "launch"), f.interpreter, "v2", "daemon", "run", "--data-dir", f.dataDir];
  if (JSON.stringify(after.unit?.exec) !== JSON.stringify(expectedExec)) fail("adopt_unverified", `unit ExecStart after daemon install is ${JSON.stringify(after.unit?.exec)}, expected ${JSON.stringify(expectedExec)}`);
  if (after.currentLink !== f.running.sourceRevision) fail("adopt_unverified", `current -> ${after.currentLink} after daemon install, expected ${f.running.sourceRevision}`);
  if (!after.installed.includes(f.running.sourceRevision)) fail("adopt_unverified", `runtime/${f.running.sourceRevision} was not retained`);
  if (!after.launcher) fail("adopt_unverified", `launcher ${f.runtimeRoot}/launch missing`);
  if (f.platform === "linux") {
    if (after.unit?.killMode !== "process") fail("adopt_unverified", `KillMode after daemon install is ${after.unit?.killMode}`);
    if (!/launch/.test(after.systemdExec ?? "")) fail("adopt_unverified", `systemd did not reload the unit: ${after.systemdExec}`);
  } else if (!after.unit?.abandonProcessGroup) fail("adopt_unverified", "plist lacks AbandonProcessGroup after daemon install");
  const dropped = Object.keys(f.unit?.env ?? {}).filter((k) => !(k in (after.unit?.env ?? {})));
  if (dropped.length) fail("adopt_unverified", `unit environment lost ${dropped.join(", ")}`);
  if (unitPath && after.unit?.env?.PATH !== unitPath) fail("adopt_unverified", `unit PATH changed from ${unitPath} to ${after.unit?.env?.PATH}`);
  step("adopt", `${out.adopted ? `${out.adopted.copied ? "copied" : "retained"} runtime ${out.adopted.sha} from ${out.adopted.source}; ` : ""}unit now runs ${expectedExec[0]} ${expectedExec[1]} v2 daemon run --data-dir ${f.dataDir}; current -> ${after.currentLink}; PATH kept`);
  return { adopted: out.adopted, facts: after };
}

function successorWaitSeconds(f) {
  const perGb = 120;
  return Math.min(1800, SUCCESSOR_WAIT_S + Math.ceil((f.storeBytes ?? 0) / 1e9) * perGb);
}

async function waitForSuccessor(f, oldPid, sha) {
  const entry = join(f.runtimeRoot, "current", "dist", "cli.js");
  const waitS = successorWaitSeconds(f);
  const r = await remote(`
NODE=${q(f.interpreter)}; DATA=${q(f.dataDir)}; ENTRY=${q(entry)}; OLD=${q(String(oldPid))}; R=${q(f.runtimeRoot)}; TARGET=${q(sha)}
i=0; PID=-; RUNNING=-; BOOTING=0
while [ $i -lt ${waitS} ]; do
  P=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$DATA/hived.endpoint.json" 2>/dev/null)
  if [ -n "$P" ] && [ "$P" != "$OLD" ] && kill -0 "$P" 2>/dev/null; then
    PID=$P
    INFO=$("$NODE" "$ENTRY" deploy-info --json --data-dir "$DATA" 2>/dev/null | tail -1)
    if [ -n "$INFO" ]; then
      RUNNING=$(printf '%s' "$INFO" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const s=JSON.parse(d);console.log((s.identity&&s.identity.sourceRevision)||"-")}catch{console.log("-")}})')
      if [ "$RUNNING" != "-" ]; then echo WAITED=$i; echo NEW_PID=$PID; echo RUNNING=$RUNNING; echo BOOTING=$BOOTING; exit 0; fi
      BOOTING=$((BOOTING+1))
      CUR=$(readlink "$R/current" 2>/dev/null || echo -)
      if [ "$CUR" != "$TARGET" ] || [ -f "$R/rollback.json" ]; then echo WAITED=$i; echo NEW_PID=$PID; echo RUNNING=-; echo BOOTING=$BOOTING; echo REVERTED=yes; exit 0; fi
    fi
  fi
  i=$((i+1)); sleep 1
done
echo WAITED=$i; echo NEW_PID=$PID; echo RUNNING=$RUNNING; echo BOOTING=$BOOTING
echo MARKER=$(cat "$R/handover.json" 2>/dev/null | tr -d '\\n' || echo -)
echo ROLLBACK=$(cat "$R/rollback.json" 2>/dev/null | tr -d '\\n' || echo -)
echo CURRENT=$(readlink "$R/current" 2>/dev/null || echo -)
tail -c 4000 "$DATA/hived.log" 2>/dev/null | tail -n 12
exit 7
`, { timeoutMs: (waitS + 60) * 1000, allowFailure: true });
  const w = kv(r.stdout);
  if (r.code !== 0) fail("successor_missing", `no successor daemon reported its build within ${waitS} s on ${options.host} (pid ${w.NEW_PID ?? "-"}, ${w.BOOTING ?? 0} answers while still booting, current -> ${w.CURRENT ?? "?"}, marker ${w.MARKER ?? "-"}, rollback ${w.ROLLBACK ?? "-"}); log tail:\n${r.stdout.split("\n").slice(-12).join("\n")}`);
  const running = w.RUNNING && w.RUNNING !== "-" ? w.RUNNING : null;
  step("successor", `pid ${w.NEW_PID} reports ${running ?? "no build"} after ${w.WAITED} s${Number(w.BOOTING) > 0 ? ` (${w.BOOTING} answers while still booting, store ${fmtBytes(f.storeBytes)})` : ""}`);
  if (w.REVERTED === "yes" || running !== sha) fail("activation_reverted", `the successor runs ${running ?? "unknown"}, not ${sha}; current or rollback.json shows the launcher or the daemon reverted the activation`, { running });
  return { pid: Number(w.NEW_PID), waitedS: Number(w.WAITED), bootingAnswers: Number(w.BOOTING ?? 0) };
}

async function verifyAfter(f, sha, before, newPid) {
  const after = await readFacts();
  const byKey = new Map(after.liveRuntimes.map((r) => [`${r.beeId}:${r.generation}`, r]));
  const adopted = [], lost = [];
  for (const r of before) {
    const now = byKey.get(`${r.beeId}:${r.generation}`);
    if (now && now.pid === r.pid && now.state !== "stopped") adopted.push(r); else lost.push({ ...r, now: now ? { state: now.state, pid: now.pid } : "gone" });
  }
  const log = await remote(`DATA=${q(f.dataDir)}; tail -c 20000000 "$DATA/hived.log" 2>/dev/null | awk -v p=${q(String(newPid))} 'index($0, "\\"op\\":\\"boot adopted=") { last = $0 } index($0, "daemon.started pid=" p " ") { print last; exit }' | sed -n 's/.*"op":"\\(boot adopted=[^"]*\\)".*/\\1/p'`, { allowFailure: true });
  const bootLine = log.stdout.trim();
  const status = after.runtimeStatus;
  const summary = { expected: before.length, adopted: adopted.length, stopped: lost.length, bootAdopt: bootLine || "-", current: after.currentLink, previous: after.previousLink, marker: after.marker, store: after.store, handover: status?.handover?.result ?? null, running: after.running?.sourceRevision };
  step("verify", `census: adopted=${adopted.length} expected=${before.length} stopped=${lost.length}; daemon log: ${bootLine || "no boot line found"}; current -> ${after.currentLink}, previous -> ${after.previousLink ?? "none"}, marker ${after.marker ? "PRESENT" : "none"}; store ${after.store?.schemaVersion}/${after.store?.minReaderSchema}`);
  if (lost.length) fail("handover_incomplete", `${lost.length} of ${before.length} runtimes did not survive the swap: ${JSON.stringify(lost)}`, summary);
  if (after.currentLink !== sha) fail("activation_reverted", `current -> ${after.currentLink} after the swap`, summary);
  if (after.marker) fail("handover_incomplete", `handover.json still present after the successor listened`, summary);
  if (status?.handover?.result && (status.handover.result.reverted || status.handover.result.adopted < status.handover.result.expected)) fail("handover_incomplete", `the daemon's own handover record: ${JSON.stringify(status.handover.result)}`, summary);
  return { summary, facts: after };
}

async function probe(f) {
  if (!options.probe) { step("probe", "skipped (--no-probe)"); return null; }
  const r = await remote(`${q(f.interpreter)} ${q(join(f.runtimeRoot, "current", "dist", "cli.js"))} runtime probe --json --data-dir ${q(f.dataDir)}`, { timeoutMs: 240_000, allowFailure: true });
  const out = json(r.stdout);
  if (r.code !== 0 || !out || out.error) {
    const error = out?.error ?? null;
    const finding = { ok: false, code: error?.code ?? "probe_failed", reason: error?.details?.reason ?? null, message: error?.message ?? (r.stdout + r.stderr).trim().slice(-600) };
    findings.push({ kind: "probe", ...finding });
    step("probe", `FINDING: the swap is verified but hive runtime probe failed on ${options.host}: ${finding.code}${finding.reason ? ` (${finding.reason})` : ""}: ${finding.message}`);
    return finding;
  }
  step("probe", `canary ${out.canary?.beeId ?? "?"} idle after ${out.canary?.idleAfterMs ?? "?"} ms, deleted after ${out.canary?.deletedAfterMs ?? "?"} ms; ${out.degraded ?? "?"} degraded; handover ${out.handover ? `${out.handover.adopted}/${out.handover.expected}` : "none recorded"}`);
  return out;
}

async function switchByActivate(f, sha) {
  const cmd = `${q(f.interpreter)} ${q(join(f.runtimeRoot, "current", "dist", "cli.js"))} runtime activate ${sha} --json --data-dir ${q(f.dataDir)}`;
  if (options.dryRun) { step("activate", `DRY RUN would run on ${options.host}: ${cmd}\n  then wait for a successor pid, read deploy-info, compare the census, run runtime probe`); return; }
  const oldPid = f.endpoint.pid;
  const r = await remote(cmd, { timeoutMs: 150_000, allowFailure: true });
  const out = json(r.stdout);
  if (r.code !== 0 || !out) fail("activate_failed", `hive runtime activate failed on ${options.host}: ${(r.stdout + r.stderr).trim().slice(-800)}`);
  step("activate", `${out.from ?? "none"} -> ${out.sha}; census ${out.census.runtimes} runtimes (${out.census.degraded} degraded); ${out.service.platform} restarts ${out.service.label}`);
  const successor = await waitForSuccessor(f, oldPid, sha);
  const verified = await verifyAfter(f, sha, f.liveRuntimes, successor.pid);
  const probed = await probe(verified.facts);
  return { out, successor, ...verified.summary, probe: probed };
}

async function switchByRestart(f, sha) {
  const fromSha = f.running.sourceRevision;
  const restart = restartCommand(f);
  if (options.dryRun) { step("switch", `DRY RUN would on ${options.host}: previous -> ${fromSha}, current -> ${sha} (symlink + rename), rm handover.attempts, write ${f.runtimeRoot}/handover.json {fromPid ${f.endpoint?.pid}, fromSha ${fromSha}, toSha ${sha}}, then: ${restart}\n  then wait for a successor pid (the launcher reverts current -> previous after 3 failed boots), read deploy-info, compare the census of ${f.liveRuntimes.length} live runtimes (same bee, generation and pid), run runtime probe`); return; }
  const oldPid = f.endpoint.pid;
  await remote(`
set -e
R=${q(f.runtimeRoot)}; NODE=${q(f.interpreter)}
"$NODE" -e '
const fs = require("node:fs"), path = require("node:path");
const [root, fromSha, toSha, fromPid] = process.argv.slice(1);
const link = (name, target) => { const tmp = path.join(root, "." + name + "." + process.pid + ".tmp"); fs.rmSync(tmp, { force: true }); fs.symlinkSync(target, tmp); fs.renameSync(tmp, path.join(root, name)); };
link("previous", fromSha);
link("current", toSha);
fs.rmSync(path.join(root, "handover.attempts"), { force: true });
const marker = path.join(root, "handover.json"), tmp = marker + "." + process.pid + ".tmp";
fs.writeFileSync(tmp, JSON.stringify({ fromPid: Number(fromPid), fromSha, toSha, at: Date.now() }) + "\\n", { mode: 0o644 });
fs.renameSync(tmp, marker);
console.log("LINKS=ok");
' "$R" ${q(fromSha)} ${q(sha)} ${q(String(oldPid))}
`);
  step("switch", `previous -> ${fromSha}, current -> ${sha}, handover.json written (from pid ${oldPid})`);
  const r = await remote(restart, { timeoutMs: 120_000, allowFailure: true });
  if (r.code !== 0) step("switch", `restart command exited ${r.code}: ${(r.stdout + r.stderr).trim().slice(-300)}`);
  else step("switch", `issued: ${restart}`);
  const successor = await waitForSuccessor(f, oldPid, sha);
  const verified = await verifyAfter(f, sha, f.liveRuntimes, successor.pid);
  const probed = await probe(verified.facts);
  return { successor, ...verified.summary, probe: probed };
}

async function apply() {
  const sha = options.sha;
  const scratch = mkdtempSync(join(tmpdir(), "hb-fleet-rollout-"));
  try {
    const f = await readFacts();
    step("facts", `${options.host} is ${f.target}; hived ${f.running?.sourceRevision ?? "not answering"} pid ${f.endpoint?.pid ?? "-"}; unit ${f.exec.form}${f.unit?.killMode ? ` KillMode=${f.unit.killMode}` : ""}; store ${f.store ? `${f.store.schemaVersion ?? "?"}/${f.store.minReaderSchema ?? "none"}` : "unknown"}; ${f.liveRuntimes.length} live runtimes of ${f.bees ?? "?"} bees; ${fmtBytes(f.freeBytes)} free; activate verb ${f.hasActivate ? "present" : "absent"}`);
    if (alreadyThere(f, sha)) { step("done", `${options.host} already runs ${sha} through the launcher; nothing to do`); return { host: options.host, sha, changed: false, inventory: inventoryRow(f) }; }
    const artifact = await prepareArtifact(sha, f.target, scratch);
    step("artifact", `${basename(artifact.tarball)} ${fmtBytes(artifact.bytes)} from ${artifact.source}; gate ${artifact.gate}; schema ${artifact.schema}; sums and build identity verified locally`);
    const problems = preflight(f, sha, artifact);
    if (problems.length) fail("preflight_failed", `preflight refused ${options.host}:\n  - ${problems.join("\n  - ")}`);
    const useActivate = f.hasActivate && f.exec.form === "launcher";
    const route = useActivate ? "runtime.activate" : f.hasActivate ? "service reload (the unit changes form this run, so the loaded service is restarted from outside)" : "first hop (marker + service restart)";
    step("plan", `${f.running.sourceRevision} -> ${sha} via ${route}; ${f.liveRuntimes.length} live runtimes must survive: ${f.liveRuntimes.map((r) => `${r.name ?? r.beeId.slice(0, 8)}#${r.generation}@${r.pid}`).join(", ") || "none"}`);
    const retention = retentionAfter(f);
    if (!retention.ok) fail("retention_unknown", `refusing ${options.host}: ${retention.reason}; the retention mode after activation cannot be established`);
    step("retention", describeRetention(retention));
    await backupBefore(f, sha);
    await shipAndInstall(f, sha, artifact);
    await applyConfigSets(f, sha);
    const adoption = await adoptUnit(f, sha);
    const current = adoption.facts ?? f;
    const result = useActivate ? await switchByActivate(current, sha) : await switchByRestart(current, sha);
    if (options.dryRun) { step("done", "DRY RUN: nothing was changed"); return { host: options.host, sha, dryRun: true, route, retention, sets: options.sets, inventory: inventoryRow(f) }; }
    const final = await readFacts();
    step("done", `${options.host} runs ${final.running?.sourceRevision} pid ${final.endpoint?.pid}; current -> ${final.currentLink}, previous -> ${final.previousLink}; ${final.liveRuntimes.length} live runtimes; store ${final.store?.schemaVersion}/${final.store?.minReaderSchema}${findings.length ? `; ${findings.length} finding(s) to read above` : ""}`);
    return { host: options.host, sha, changed: true, route, retention: retentionAfter(final), sets: options.sets, result, inventory: inventoryRow(final) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

async function rollback() {
  const f = await readFacts();
  if (!f.lastBackup) fail("no_backup", `no fleet-rollout backup recorded under ${f.runtimeRoot}/.fleet-rollout on ${options.host}`);
  const r = await remote(`D=${q(f.lastBackup)}; cat "$D/state.json"; echo; echo UNIT_B64=$(base64 < "$D/unit.before" | tr -d '\\n')`);
  const state = JSON.parse(r.stdout.slice(0, r.stdout.indexOf("\nUNIT_B64=")));
  const unitBefore = b64(kv(r.stdout).UNIT_B64);
  const oldSha = state.runningSha;
  step("facts", `${options.host} runs ${f.running?.sourceRevision ?? "nothing"}; backup ${f.lastBackup} from ${new Date(state.at).toISOString()} recorded ${oldSha} on unit form ${state.unitForm}, current -> ${state.currentLink ?? "none"}; store now ${f.store?.schemaVersion}/${f.store?.minReaderSchema}`);
  if (f.running?.sourceRevision === oldSha && f.unitText === unitBefore && f.currentLink === state.currentLink) { step("done", "already rolled back"); return { host: options.host, changed: false }; }
  const oldDir = state.unitForm === "explicit" ? state.runningDir : join(f.runtimeRoot, oldSha);
  const schemaCheck = await remote(`DIR=${q(oldDir)}; echo OLD_SCHEMA=$(grep -hoE '^(var|let|const) SCHEMA_VERSION[0-9]* = [0-9]+;$' "$DIR"/dist/v2/cli*.js 2>/dev/null | grep -oE '[0-9]+;$' | tr -d ';' | sort -u | tr '\\n' ','); echo OLD_ID=$(tr -d '\\n ' < "$DIR/dist/build-identity.json" 2>/dev/null || echo -)`);
  const s = kv(schemaCheck.stdout);
  const oldSchema = (s.OLD_SCHEMA ?? "").split(",").filter(Boolean).map(Number);
  const oldId = s.OLD_ID && s.OLD_ID !== "-" ? JSON.parse(s.OLD_ID) : null;
  if (oldId?.sourceRevision !== oldSha) fail("rollback_refused", `${oldDir} is not the ${oldSha} build recorded in the backup`);
  const minReader = f.store?.minReaderSchema ?? f.store?.schemaVersion ?? null;
  if (oldSchema.length !== 1) fail("rollback_refused", `cannot read the schema of ${oldDir}`);
  if (minReader != null && minReader > oldSchema[0] && !options.forceStore) fail("rollback_refused", `the store now needs a reader at schema ${minReader}; ${oldSha} is schema ${oldSchema[0]}. The old build would refuse the store. A rollback needs the pre-migration store backup under ${f.dataDir}/core.sqlite3.backups restored by hand (state since the swap is lost). Pass --force-store only if that was done.`);
  const restart = restartCommand(f);
  const relink = state.currentLink ? `link("current", ${JSON.stringify(state.currentLink)});` : `fs.rmSync(path.join(root, "current"), { force: true });`;
  const reprev = state.previousLink ? `link("previous", ${JSON.stringify(state.previousLink)});` : `fs.rmSync(path.join(root, "previous"), { force: true });`;
  if (options.dryRun) { step("rollback", `DRY RUN would on ${options.host}: write ${f.unitPath} back to its exact pre-swap bytes (${unitBefore.length} bytes, ExecStart ${JSON.stringify(parseUnit(unitBefore, f.platform).exec)}), current -> ${state.currentLink ?? "removed"}, previous -> ${state.previousLink ?? "removed"}, remove handover.json/handover.attempts, then: ${restart}; then verify ${oldSha} serves and the ${f.liveRuntimes.length} live runtimes kept their pid and generation`); return { host: options.host, dryRun: true }; }
  const oldPid = f.endpoint?.pid ?? 0;
  await remote(`
set -e
R=${q(f.runtimeRoot)}; NODE=${q(f.interpreter)}; UNIT=${q(f.unitPath)}
echo ${q(Buffer.from(unitBefore).toString("base64"))} | base64 --decode > "$UNIT.tmp.$$" && mv "$UNIT.tmp.$$" "$UNIT"
"$NODE" -e '
const fs = require("node:fs"), path = require("node:path");
const root = process.argv[1];
const link = (name, target) => { const tmp = path.join(root, "." + name + "." + process.pid + ".tmp"); fs.rmSync(tmp, { force: true }); fs.symlinkSync(target, tmp); fs.renameSync(tmp, path.join(root, name)); };
${relink}
${reprev}
for (const name of ["handover.json", "handover.attempts", "rollback.json"]) fs.rmSync(path.join(root, name), { force: true });
console.log("LINKS=ok");
' "$R"
`);
  step("rollback", `unit restored byte for byte; current -> ${state.currentLink ?? "removed"}, previous -> ${state.previousLink ?? "removed"}`);
  const rr = await remote(restart, { timeoutMs: 120_000, allowFailure: true });
  step("rollback", rr.code === 0 ? `issued: ${restart}` : `restart command exited ${rr.code}: ${(rr.stdout + rr.stderr).trim().slice(-300)}`);
  const successor = await waitForSuccessor({ ...f, interpreter: state.interpreter ?? f.interpreter, runtimeRoot: f.runtimeRoot }, oldPid, oldSha).catch(async (error) => {
    if (error.code !== "activation_reverted") throw error;
    throw error;
  });
  const after = await readFacts();
  const byKey = new Map(after.liveRuntimes.map((r) => [`${r.beeId}:${r.generation}`, r]));
  const lost = f.liveRuntimes.filter((r) => { const now = byKey.get(`${r.beeId}:${r.generation}`); return !(now && now.pid === r.pid && now.state !== "stopped"); });
  step("verify", `boot adopted=${f.liveRuntimes.length - lost.length} expected=${f.liveRuntimes.length} stopped=${lost.length}; running ${after.running?.sourceRevision} pid ${successor.pid}; unit ${after.exec.form}; current -> ${after.currentLink}`);
  if (lost.length) fail("handover_incomplete", `${lost.length} runtimes did not survive the rollback: ${JSON.stringify(lost)}`);
  if (after.unitText !== unitBefore) fail("rollback_unverified", "the unit on disk differs from the backup");
  await remote(`rm -f ${q(join(f.runtimeRoot, ".fleet-rollout", "last"))}`);
  return { host: options.host, changed: true, rolledBackTo: oldSha, successor, adopted: f.liveRuntimes.length - lost.length, expected: f.liveRuntimes.length };
}

try {
  let result;
  if (options.inventory) { const f = await readFacts(); printInventory(f); result = null; }
  else if (options.rollback) result = await rollback();
  else result = await apply();
  if (options.json && result) console.log(JSON.stringify({ ok: true, ...result, findings, steps }));
  else if (findings.length) say(`findings: ${findings.map((f) => `${f.kind} ${f.code}${f.reason ? ` (${f.reason})` : ""}`).join("; ")}`);
} catch (error) {
  const code = error.code ?? "error";
  if (options.json) console.log(JSON.stringify({ ok: false, code, message: error.message, detail: error.detail ?? null, steps }));
  else console.error(`fleet-rollout: ${code}: ${error.message}`);
  process.exit(code === "preflight_failed" ? 2 : 1);
}
