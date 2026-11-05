#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const root = resolve(option("--root", "."));
const oldRoot = resolve(option("--old-root", "/tmp/hb-main"));
const out = resolve(option("--out", ".proof/m-h8/tmux-retire.json"));

const local = (file) => import(pathToFileURL(join(root, file)).href);
const old = (file) => import(pathToFileURL(join(oldRoot, file)).href);
const { makeDaemonDir, startDaemon, waitFor, sleep } = await local("v2/daemon/tests/helpers.ts");
const { liveTmuxRuntimes, liveTmuxRuntimesFromDaemon, DeployTmuxRuntimesLiveError } = await local("v2/cli/src/deploy/command.ts");
const { openCoreStore } = await old("v2/core/src/store.ts");
const { DaemonCore } = await old("v2/daemon/src/loops.ts");
const { TmuxServer } = await old("v2/driver-tmux/src/tmux.ts");
const { makeRig } = await old("v2/driver-tmux/tests/helpers.ts");

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const steps = [];
const record = (step, ok, detail = {}) => { steps.push({ step, ok, ...detail }); console.log(`${ok ? "ok " : "FAIL"} ${step} ${JSON.stringify(detail)}`); };

const { dir, cleanup } = makeDaemonDir({ tickMs: 200, stubEnv: { STUB_TURN_MS: "50" } });
const storePath = join(dir, "core.sqlite3");
const rig = makeRig();
const store = openCoreStore(storePath);
const driver = rig.driver;
let paneBee, panePid, paneRuntime, panes;
try {
  const core = new DaemonCore({ store, driver, now: () => Date.now(), log: () => {}, policy: { commandsPerStep: 8, idleWindowSteps: null, bootHangTimeoutSteps: 100_000 } });
  core.boot();
  paneBee = store.createBee({ name: "pane-bee", agent: "stub", substrate: "tmux", cwd: rig.dir }).bee;
  rig.configure(paneBee.id, "transcript");
  store.enqueueCommand("spawn", paneBee.id);
  const deadline = Date.now() + 30_000;
  for (;;) {
    core.step();
    const rt = store.currentRuntime(paneBee.id);
    if (rt && rt.pid != null && rt.state !== "stopped" && rt.state !== "booting") { paneRuntime = rt; break; }
    if (Date.now() > deadline) { paneRuntime = rt; break; }
    await sleep(50);
  }
  panePid = paneRuntime?.pid ?? null;
  panes = execFileSync("tmux", ["-S", rig.socketPath, "list-panes", "-a", "-F", "#{session_name} #{pane_pid} #{pane_dead}"], { encoding: "utf8" }).trim();
  record("old daemon: tmux bee runs in a pane", paneRuntime != null && paneRuntime.state !== "stopped" && panePid != null && pidAlive(panePid), { state: paneRuntime?.state, generation: paneRuntime?.generation, pid: panePid, panes, identity: store.runtimeProcessIdentity(paneBee.id, paneRuntime?.generation ?? 1).kind });
  driver.detachAll();
} finally {
  store.close();
}

const blocking = liveTmuxRuntimes(storePath);
const refusal = blocking.length > 0 ? new DeployTmuxRuntimesLiveError(blocking).message : null;
record("hive deploy refuses typed while the pane runtime is live", blocking.length === 1 && blocking[0].id === paneBee.id && refusal.includes("DEPLOY_TMUX_RUNTIMES_LIVE") && refusal.includes("pane-bee"), { blocking, refusal });

let daemon = await startDaemon(dir);
let client;
let report;
try {
  client = await daemon.client();
  await waitFor(() => readFileSync(join(dir, "hived.log"), "utf8").includes("boot.tmux_retired"), "boot retirement logged", 15_000, 50);
  const logLine = readFileSync(join(dir, "hived.log"), "utf8").split("\n").map((l) => { try { return JSON.parse(l).op; } catch { return ""; } }).find((op) => op.startsWith("boot.tmux_retired"));
  const view = await client.request("view", { beeId: paneBee.id });
  const row = view.runtime;
  const panesAfterBoot = execFileSync("tmux", ["-S", rig.socketPath, "list-panes", "-a", "-F", "#{session_name} #{pane_pid} #{pane_dead}"], { encoding: "utf8" }).trim();
  record("new daemon boots over the live pane: row settled, pane untouched, bee reachable", view.bee?.substrate === "hsr" && row.state === "stopped" && row.exitCause === "stopped_by_system" && row.generation === paneRuntime.generation && pidAlive(panePid) && view.view.reachable !== false, { logLine, substrate: view.bee?.substrate, runtime: row, panePidAlive: pidAlive(panePid), panesAfterBoot, flags: view.view.flags });
  const cliHome = join(dir, "cli-home");
  mkdirSync(cliHome, { recursive: true });
  const viaDaemon = await liveTmuxRuntimesFromDaemon(process.execPath, [join(root, "v2/cli/src/bin.ts"), "ls", "--json", "--all", "--data-dir", dir, "--socket", daemon.socketPath], { ...process.env, HOME: cliHome, HIVE_NO_KEYCHAIN: "1" });
  let storeRead;
  try { storeRead = { rows: liveTmuxRuntimes(storePath) }; } catch (error) { storeRead = { error: String(error.message).slice(0, 120) }; }
  record("hive deploy asks the running daemon and no longer refuses after retirement", viaDaemon.length === 0, { viaDaemon, storeReadWhileDaemonRuns: storeRead });

  const sent = await client.request("send", { beeId: paneBee.id, body: "hello after the tmux retirement" });
  const after = await waitFor(async () => {
    const delivered = (await client.request("mailbox", { beeId: paneBee.id })).messages.find((m) => m.id === sent.messageId)?.deliveredAt != null;
    const v = await client.request("view", { beeId: paneBee.id });
    return delivered && v.view.runtimeState === "idle" && v.runtime?.generation === paneRuntime.generation + 1 && v.view.lastOutputAt != null ? v : null;
  }, "mail delivered and the hsr generation idle again", 30_000, 50);
  const row2 = after.runtime;
  const panesAfterMail = execFileSync("tmux", ["-S", rig.socketPath, "list-panes", "-a", "-F", "#{session_name} #{pane_pid} #{pane_dead}"], { encoding: "utf8" }).trim();
  record("mail wakes the bee under hsr; the old pane keeps running", row2.generation === paneRuntime.generation + 1 && row2.state === "idle" && row2.pid !== panePid && pidAlive(panePid) && after.view.lastOutputAt != null, { runtime: row2, panePidAlive: pidAlive(panePid), panesAfterMail, delivered: sent.messageId });
  await client.request("stop", { beeId: paneBee.id });
  await waitFor(async () => (await client.request("view", { beeId: paneBee.id })).view.runtimeState === "stopped", "stopped", 30_000, 50);
  report = { timestamp: new Date().toISOString(), hostname: hostname(), node: process.version, root, oldRoot, ok: steps.every((s) => s.ok), steps };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ out, ok: report.ok }));
} finally {
  client?.close();
  await daemon.stop().catch(() => {});
  try { new TmuxServer({ socketPath: rig.socketPath, allowKillServer: true }).killServer(); } catch {}
  await sleep(200);
  console.log(JSON.stringify({ panePidAliveAfterTeardown: panePid ? pidAlive(panePid) : null }));
  cleanup();
}
