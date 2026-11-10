// Studio side of the fleet-rollout lab. Builds a scratch node on a Linux host through lab-setup.mjs
// (an Apiary-style explicit-entry unit running a real old build with stub bees), then drives
// scripts/fleet-rollout.mjs from this machine against it exactly as the coordinator would against a
// real host, with --lab-root so every path, the unit and the service manager are the scratch node's.
//   node .proof/fleet-rollout/lab.mjs --host trmd@netcup-1 --old <host dir .../lib/node_modules/honeybee> \
//     --artifact <host dir with the b3c17a40 artifact> --sha <sha> --node /opt/node-v24.18.0-linux-x64/bin/node \
//     --repo /var/tmp/hb-fleet-build/honeybee --name hop-9d95df22 [--keep]
import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) { const k = argv[i].slice(2); opt[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
const need = (k) => { if (opt[k] === undefined) throw new Error(`--${k} required`); return opt[k]; };
const HOST = need("host"), OLD = need("old"), ARTIFACT = need("artifact"), SHA = need("sha"), NODE = need("node"), REPO = need("repo"), NAME = opt.name ?? "lab";
const OUT = join(here, `${NAME}.jsonl`);
const SHA_B = "b".repeat(40), SHA_C = "c".repeat(40);
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/hb-fleet-rollout-%C", "-o", "ControlPersist=120"];
const lines = [];
const record = (entry) => { const row = { at: new Date().toISOString(), ...entry }; lines.push(row); writeFileSync(OUT, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`); console.log(JSON.stringify(row)); };
const fail = (message) => { record({ step: "FAIL", message }); throw new Error(message); };
const expect = (name, passed, detail = {}) => { const pass = Boolean(passed); record({ step: name, pass, ...detail }); if (!pass) fail(`${name}: ${JSON.stringify(detail).slice(0, 2000)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastJson = (text) => { const line = text.trim().split("\n").filter((l) => l.startsWith("{")).at(-1); try { return line ? JSON.parse(line) : null; } catch { return null; } };
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const mutating = (calls) => calls.filter((c) => !/ (show|is-active) /.test(c));

async function ssh(command, { timeoutMs = 300_000 } = {}) {
  try { const r = await execFileAsync("ssh", [...SSH, HOST, command], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }); return { code: 0, ...r }; }
  catch (error) { return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
}
const labTool = `${q(NODE)} /var/tmp/hb-fleet-build/lab-setup.mjs`;
async function lab(command, args) { const r = await ssh(`${labTool} ${command} ${args}`); const j = lastJson(r.stdout); if (!j) fail(`lab-setup ${command}: ${r.stdout.slice(-800)} ${r.stderr.slice(-800)}`); return j; }
let labRoot = null;
const status = (pids = []) => lab("status", `--root ${q(labRoot)} --pids ${pids.join(",") || "0"}`);

async function rollout(args, { timeoutMs = 600_000 } = {}) {
  const started = performance.now();
  const child = spawn(process.execPath, [join(repo, "scripts", "fleet-rollout.mjs"), HOST, ...args, "--json", "--lab-root", labRoot], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise((r) => child.on("close", (c) => r(c)));
  clearTimeout(timer);
  const result = lastJson(stdout);
  return { code, ms: Math.round(performance.now() - started), result, stderr: stderr.slice(-1500), stepsText: (result?.steps ?? []).map((s) => `${s.step}: ${s.message ?? JSON.stringify(s)}`) };
}

async function hostCli(entry, args) { const r = await ssh(`${q(NODE)} ${q(entry)} ${args} --json --data-dir ${q(join(labRoot, "v2"))}`); return { ...r, json: lastJson(r.stdout) }; }

async function mailLands(entry, beeId, body) {
  const sent = await hostCli(entry, `send ${beeId} ${q(body)}`);
  if (!sent.json?.messageId) return { ok: false, sent: sent.stdout.slice(-300) + sent.stderr.slice(-300) };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const box = await hostCli(entry, `mailbox ${beeId}`);
    const row = (box.json?.messages ?? []).find((m) => m.body === body);
    if (row?.deliveredAt) return { ok: true, messageId: sent.json.messageId, deliveredGeneration: row.deliveredGeneration ?? null };
    await sleep(300);
  }
  return { ok: false, messageId: sent.json.messageId, undelivered: true };
}

let exitCode = 0;
try {
  await execFileAsync("scp", ["-q", ...SSH, join(here, "lab-setup.mjs"), `${HOST}:/var/tmp/hb-fleet-build/lab-setup.mjs`]);
  labRoot = `/var/tmp/hb-fleet-lab-${NAME}-${Date.now().toString(36)}`;
  const setup = await lab("setup", `--root ${q(labRoot)} --old ${q(OLD)} --node ${q(NODE)} --repo ${q(REPO)} --bees 3`);
  const bees = setup.bees;
  const pids = bees.map((b) => b.pid);
  record({ step: "lab.setup", ...setup });
  expect("lab.old_daemon_serves", setup.running !== null && bees.length === 3, { running: setup.running, protocol: setup.protocol, bees });
  const before = await status(pids);
  const unitBefore = before.unitSha256;
  const newEntry = join(labRoot, "runtime", "current", "dist", "cli.js");

  const inventory = await rollout(["--inventory"]);
  record({ step: "inventory", ms: inventory.ms, row: inventory.result?.inventory, liveRuntimes: inventory.result?.facts?.liveRuntimes });
  expect("inventory.reads_old_node", inventory.code === 0 && inventory.result?.inventory?.running === setup.running && inventory.result.inventory.unitForm === "explicit" && inventory.result.inventory.liveRuntimes === 3, { row: inventory.result?.inventory });

  const dry = await rollout([SHA, "--artifact", `${HOST}:${ARTIFACT}`, "--dry-run"]);
  record({ step: "dry_run", ms: dry.ms, code: dry.code, steps: dry.stepsText, stderr: dry.stderr });
  const afterDry = await status(pids);
  expect("dry_run.changes_nothing", dry.code === 0 && dry.result?.ok && dry.result.dryRun === true && afterDry.unitSha256 === unitBefore && afterDry.mainPid === before.mainPid && afterDry.links.current === before.links.current && afterDry.installed.length === 0 && mutating(afterDry.systemctl).length === mutating(before.systemctl).length, { before: { unit: unitBefore, mainPid: before.mainPid, links: before.links, installed: before.installed }, after: { unit: afterDry.unitSha256, mainPid: afterDry.mainPid, links: afterDry.links, installed: afterDry.installed, systemctl: afterDry.systemctl } });

  const hop1 = await rollout([SHA, "--artifact", `${HOST}:${ARTIFACT}`]);
  record({ step: "hop1", ms: hop1.ms, code: hop1.code, steps: hop1.stepsText, result: hop1.result && { route: hop1.result.route, result: hop1.result.result, inventory: hop1.result.inventory }, stderr: hop1.stderr });
  const afterHop1 = await status(pids);
  record({ step: "hop1.host", ...afterHop1 });
  expect("hop1.first_hop_route", hop1.code === 0 && hop1.result?.ok && /first hop/.test(hop1.result.route), { route: hop1.result?.route, code: hop1.code });
  expect("hop1.bees_kept", pids.every((p) => afterHop1.pids[p]) && hop1.result.result.adopted === 3 && hop1.result.result.expected === 3 && hop1.result.result.stopped === 0, { pids: afterHop1.pids, adopted: hop1.result.result.adopted, expected: hop1.result.result.expected, stopped: hop1.result.result.stopped, bootAdopt: hop1.result.result.bootAdopt });
  expect("hop1.unit_through_launcher", /runtime\/launch/.test(afterHop1.unitExecStart) && afterHop1.links.current === SHA && afterHop1.links.previous === setup.running && afterHop1.installed.includes(SHA) && afterHop1.installed.includes(setup.running) && afterHop1.marker === false, { exec: afterHop1.unitExecStart, links: afterHop1.links, installed: afterHop1.installed, marker: afterHop1.marker });
  expect("hop1.successor_runs_target", hop1.result.inventory.running === SHA && hop1.result.inventory.unitForm === "launcher" && hop1.result.inventory.hasActivate === true, { inventory: hop1.result.inventory });
  expect("hop1.store", hop1.result.inventory.store === "59/59", { store: hop1.result.inventory.store, before: inventory.result.inventory.store });
  expect("hop1.probe", hop1.result.result.probe !== null && hop1.result.result.probe.canary?.beeId, { probe: hop1.result.result.probe });
  const mail1 = await mailLands(newEntry, bees[0].beeId, `lab-after-hop1-${Date.now()}`);
  expect("hop1.mail_delivered_same_generation", mail1.ok && (mail1.deliveredGeneration === null || mail1.deliveredGeneration === bees[0].generation), { mail1, generation: bees[0].generation });
  expect("hop1.systemctl_calls", afterHop1.systemctl.filter((c) => /restart/.test(c)).length === 1 && afterHop1.systemctl.some((c) => /daemon-reload/.test(c)), { calls: afterHop1.systemctl });

  const again = await rollout([SHA, "--artifact", `${HOST}:${ARTIFACT}`]);
  const afterAgain = await status(pids);
  expect("hop1.idempotent", again.code === 0 && again.result?.changed === false && afterAgain.mainPid === afterHop1.mainPid && mutating(afterAgain.systemctl).length === mutating(afterHop1.systemctl).length, { steps: again.stepsText, mainPid: [afterHop1.mainPid, afterAgain.mainPid] });

  const back = await rollout(["--rollback"]);
  record({ step: "rollback", ms: back.ms, code: back.code, steps: back.stepsText, result: back.result, stderr: back.stderr });
  const afterBack = await status(pids);
  record({ step: "rollback.host", ...afterBack });
  if (opt["expect-rollback-refused"]) {
    expect("rollback.refused_store_migrated", back.code !== 0 && back.result?.ok === false && back.result.code === "rollback_refused" && /min|schema/.test(back.result.message) && afterBack.unitSha256 === afterHop1.unitSha256 && afterBack.mainPid === afterHop1.mainPid && afterBack.links.current === SHA && pids.every((p) => afterBack.pids[p]), { code: back.result?.code, message: back.result?.message, links: afterBack.links, pids: afterBack.pids });
    const forced = await rollout(["--rollback", "--dry-run", "--force-store"]);
    expect("rollback.force_store_dry_run_plans", forced.code === 0 && forced.result?.dryRun === true, { steps: forced.stepsText });
  } else {
  expect("rollback.unit_and_entry_exact", back.code === 0 && back.result?.ok && afterBack.unitSha256 === unitBefore && afterBack.links.current === before.links.current && afterBack.links.previous === null && afterBack.marker === false, { unit: [unitBefore, afterBack.unitSha256], links: afterBack.links, before: before.links });
  expect("rollback.old_build_serves_bees_kept", back.result.rolledBackTo === setup.running && pids.every((p) => afterBack.pids[p]) && back.result.adopted === 3, { pids: afterBack.pids, result: back.result });
  const oldInventory = await rollout(["--inventory"]);
  expect("rollback.inventory", oldInventory.result?.inventory?.running === setup.running && oldInventory.result.inventory.unitForm === "explicit" && oldInventory.result.inventory.liveRuntimes === 3, { row: oldInventory.result?.inventory });
  const mailBack = await mailLands(setup.entry, bees[1].beeId, `lab-after-rollback-${Date.now()}`);
  expect("rollback.mail_delivered", mailBack.ok, { mailBack });

  const hop1b = await rollout([SHA, "--artifact", `${HOST}:${ARTIFACT}`]);
  const afterHop1b = await status(pids);
  record({ step: "hop1.again", ms: hop1b.ms, code: hop1b.code, steps: hop1b.stepsText, host: afterHop1b, stderr: hop1b.stderr });
  expect("hop1.again_after_rollback", hop1b.code === 0 && hop1b.result?.ok && hop1b.result.result.adopted === 3 && hop1b.result.result.stopped === 0 && pids.every((p) => afterHop1b.pids[p]) && afterHop1b.links.current === SHA, { adopted: hop1b.result?.result?.adopted, pids: afterHop1b.pids, links: afterHop1b.links, steps: hop1b.stepsText });
  }

  const artifactB = `${dirname(ARTIFACT)}/artifact-B-${NAME}`;
  const madeB = await lab("make-artifact", `--from ${q(ARTIFACT)} --sha ${SHA_B} --out ${q(artifactB)}`);
  record({ step: "artifact.B", ...madeB });
  const hop2 = await rollout([SHA_B, "--artifact", `${HOST}:${artifactB}`]);
  const afterHop2 = await status(pids);
  record({ step: "hop2", ms: hop2.ms, code: hop2.code, steps: hop2.stepsText, result: hop2.result && { route: hop2.result.route, result: hop2.result.result, inventory: hop2.result.inventory }, host: afterHop2, stderr: hop2.stderr });
  expect("hop2.activate_route", hop2.code === 0 && hop2.result?.ok && hop2.result.route === "runtime.activate", { route: hop2.result?.route, steps: hop2.stepsText });
  expect("hop2.bees_kept_handover_recorded", pids.every((p) => afterHop2.pids[p]) && hop2.result.result.adopted === 3 && hop2.result.result.stopped === 0 && hop2.result.result.handover?.adopted === 3 && hop2.result.result.handover.expected === 3 && hop2.result.result.handover.reverted === false, { pids: afterHop2.pids, result: hop2.result.result });
  expect("hop2.links", afterHop2.links.current === SHA_B && afterHop2.links.previous === SHA && afterHop2.marker === false && afterHop2.systemctl.filter((c) => /restart --no-block/.test(c)).length === 1, { links: afterHop2.links, calls: afterHop2.systemctl.slice(-4) });
  const mail2 = await mailLands(newEntry, bees[2].beeId, `lab-after-hop2-${Date.now()}`);
  expect("hop2.mail_delivered", mail2.ok, { mail2 });
  const again2 = await rollout([SHA_B, "--artifact", `${HOST}:${artifactB}`]);
  expect("hop2.idempotent", again2.code === 0 && again2.result?.changed === false, { steps: again2.stepsText });

  const artifactC = `${dirname(ARTIFACT)}/artifact-C-${NAME}`;
  const madeC = await lab("make-artifact", `--from ${q(ARTIFACT)} --sha ${SHA_C} --out ${q(artifactC)} --break`);
  record({ step: "artifact.C", ...madeC });
  const hop3 = await rollout([SHA_C, "--artifact", `${HOST}:${artifactC}`]);
  const afterHop3 = await status(pids);
  record({ step: "hop3.broken", ms: hop3.ms, code: hop3.code, steps: hop3.stepsText, result: hop3.result, host: afterHop3, stderr: hop3.stderr });
  expect("hop3.crash_loop_reverted_typed", hop3.code !== 0 && hop3.result?.ok === false && hop3.result.code === "activation_reverted", { code: hop3.result?.code, message: hop3.result?.message });
  expect("hop3.previous_serves_bees_kept", afterHop3.links.current === SHA_B && pids.every((p) => afterHop3.pids[p]) && afterHop3.marker === false && afterHop3.bootLines.some((l) => /boot\.rollback reason=crash_loop/.test(l)), { links: afterHop3.links, pids: afterHop3.pids, bootLines: afterHop3.bootLines.slice(-8) });
  const inv3 = await rollout(["--inventory"]);
  expect("hop3.inventory_running_previous", inv3.result?.inventory?.running === SHA_B && inv3.result.inventory.liveRuntimes === 3, { row: inv3.result?.inventory });
  const mail3 = await mailLands(newEntry, bees[0].beeId, `lab-after-crashloop-${Date.now()}`);
  expect("hop3.mail_delivered", mail3.ok, { mail3 });
  record({ step: "lab.done", pass: true });
} catch (error) {
  exitCode = 1;
  record({ step: "lab.error", message: error instanceof Error ? error.message : String(error) });
} finally {
  if (labRoot) {
    const save = join(here, `${NAME}-logs`);
    mkdirSync(save, { recursive: true });
    const saveRemote = `${labRoot}-logs`;
    const down = await lab("teardown", `--root ${q(labRoot)} --save ${q(saveRemote)}${opt.keep ? " --keep" : ""}`).catch((e) => ({ error: String(e) }));
    await execFileAsync("scp", ["-q", "-r", ...SSH, `${HOST}:${saveRemote}/.`, save]).catch(() => undefined);
    await ssh(`rm -rf ${q(saveRemote)}`);
    record({ step: "lab.cleanup", ...down, logs: save });
  }
}
process.exit(exitCode);
