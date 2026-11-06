#!/usr/bin/env node
// Explicit-state model of runtime.activate / the launcher / boot.handover / runtime.probe.
// Every interleaving of: the old daemon's census and retarget, runner hosts dying at any point,
// the service manager restarting the unit, a candidate crashing or listening at each attempt,
// the launcher's crash-loop revert, the successor's boot comparison and the probe's answer.
// Run: node .agents/skills/verify-runtime-handover/handover-model.mjs [--break <name>] [--hosts N] [--trace]
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({ options: { break: { type: "string", default: "" }, hosts: { type: "string", default: "2" }, trace: { type: "boolean", default: false }, json: { type: "boolean", default: false } } });
const BREAK = opts.break;
const HOSTS = Number(opts.hosts);
const ATTEMPTS = 3;

// The configuration under test. Each "break" removes one rule, the way a careless edit would.
const rules = {
  probeComparesCensus: BREAK !== "probe-ignores-census",   // v2/daemon/src/daemon.ts rpcRuntimeProbe: adopted < expected -> handover_incomplete
  probeChecksReverted: BREAK !== "probe-ignores-reverted", // rpcRuntimeProbe: result.reverted -> activation_reverted
  launcherCounts: BREAK !== "launcher-never-reverts",      // launcher.ts: N > 3 && previous -> ln -sfn previous current
  launcherClearsMarker: BREAK !== "launcher-keeps-marker", // launcher.ts: rm handover.json handover.attempts after the revert
  markerRemovedAfterListen: BREAK !== "marker-removed-before-listen", // daemon.ts start(): removeHandoverMarker after rpc.listen
  bootCompares: BREAK !== "boot-skips-comparison",         // daemon.ts recordHandoverAtBoot
};

// State. Versions are "A" (running, previous after the swap) and "B" (the candidate).
const initial = () => ({
  phase: "old_running",   // old_running | old_censused | old_stopping | unit_down | cand_booting | cand_listening | prev_booting | prev_listening | probed
  current: "A",
  previous: null,
  marker: null,           // null | "B": runtime/handover.json
  attempts: 0,            // runtime/handover.attempts
  rollback: null,         // runtime/rollback.json written by the launcher
  census: null,           // meta.handover.runtimes: the set of host ids the old daemon saw live
  result: null,           // meta.handover.result: {expected, adopted, reverted}
  hosts: Object.fromEntries(Array.from({ length: HOSTS }, (_, i) => [i, "live"])), // runner hosts: live | dead
  crashes: 0,             // candidate boots that died before listening
  probe: null,            // null | "ok" | "handover_incomplete" | "activation_reverted" | "handover_pending"
  running: "A",           // the build whose daemon process exists, or null while the unit is down
});
const key = (s) => JSON.stringify(s);
const clone = (s) => JSON.parse(JSON.stringify(s));
const liveHosts = (s) => Object.keys(s.hosts).filter((h) => s.hosts[h] === "live");

// One step of the launcher as the unit starts: count the attempt, revert after the third failure.
function launch(s) {
  if (s.marker !== null) {
    const n = s.attempts + 1;
    if (rules.launcherCounts && n > ATTEMPTS && s.previous !== null) {
      s.current = s.previous;
      s.rollback = { candidate: s.marker, attempts: n - 1 };
      if (rules.launcherClearsMarker) { s.marker = null; s.attempts = 0; } else { s.attempts = n; }
    } else {
      s.attempts = n;
    }
  }
  s.running = s.current;
  s.phase = s.current === "B" ? "cand_booting" : "prev_booting";
}

// Boot comparison: the successor adopts exactly the census hosts that are still alive.
function bootCompare(s) {
  if (s.rollback) s.rollback = null; // journaled as rollback: crash_loop
  if (s.census !== null && s.result === null && rules.bootCompares) {
    const missing = s.census.filter((h) => s.hosts[h] !== "live");
    s.result = { expected: s.census.length, adopted: s.census.length - missing.length, missing, reverted: s.running !== "B" };
  }
}

function successors(s) {
  const out = [];
  const push = (label, t) => out.push([label, t]);
  // Hosts may die at any moment, in any phase (a bee crashes, an operator kills it).
  for (const h of liveHosts(s)) { const t = clone(s); t.hosts[h] = "dead"; push(`host ${h} dies`, t); }
  switch (s.phase) {
    case "old_running": {
      const t = clone(s); t.census = liveHosts(s); t.phase = "old_censused"; push("activate: census to meta.handover", t);
      break;
    }
    case "old_censused": {
      const t = clone(s);
      t.previous = t.current; t.current = "B"; t.marker = "B";
      t.attempts = 0;
      t.result = null; t.phase = "old_stopping";
      push("activate: previous<-current, current<-B, handover.json, restart --no-block", t);
      // A probe on the old daemon before it stops answers handover_pending.
      const p = clone(s); p.probe = "handover_pending"; push("probe (old daemon, before retarget) -> handover_pending", p);
      break;
    }
    case "old_stopping": {
      const t = clone(s); t.running = null; t.phase = "unit_down"; push("old daemon exits: store closed, hosts detached (no signals)", t);
      const p = clone(s); p.probe = "handover_pending"; push("probe (old daemon, after retarget) -> handover_pending", p);
      break;
    }
    case "unit_down": {
      const t = clone(s); launch(t); push(`service manager starts the unit via the launcher (attempt ${t.attempts || "-"})`, t);
      break;
    }
    case "cand_booting": {
      if (s.crashes < ATTEMPTS + 1) { const t = clone(s); t.crashes += 1; t.running = null; t.phase = "unit_down"; push("candidate dies before listening", t); }
      const t = clone(s); bootCompare(t);
      if (rules.markerRemovedAfterListen) { t.phase = "cand_listening"; t.marker = null; t.attempts = 0; push("candidate adopts survivors, compares with census, listens, removes handover.json", t); }
      else { t.marker = null; t.attempts = 0; t.phase = "cand_listening"; push("candidate removes handover.json then listens", t); }
      if (!rules.markerRemovedAfterListen && s.crashes < ATTEMPTS + 1) {
        // The broken ordering: the marker is gone before listen, and listen itself can still fail.
        const u = clone(s); bootCompare(u); u.marker = null; u.attempts = 0; u.crashes += 1; u.running = null; u.phase = "unit_down"; push("candidate removes handover.json, then dies at listen", u);
      }
      break;
    }
    case "prev_booting": {
      const t = clone(s); bootCompare(t); t.phase = "prev_listening"; t.marker = null; t.attempts = 0; push("previous adopts survivors, journals the rollback, listens", t);
      break;
    }
    case "cand_listening":
    case "prev_listening": {
      const t = clone(s);
      const r = s.result;
      if (r === null) t.probe = s.census === null ? "ok" : "handover_pending";
      else if (rules.probeChecksReverted && r.reverted) t.probe = "activation_reverted";
      else if (rules.probeComparesCensus && r.adopted < r.expected) t.probe = "handover_incomplete";
      else t.probe = "ok";
      t.phase = "probed";
      push(`probe -> ${t.probe}`, t);
      break;
    }
    default: break;
  }
  return out;
}

// Properties, each with the harm in one sentence (see SKILL.md).
const properties = {
  // Every runtime that was live at the census is adopted by the successor, or the probe fails.
  ProbeSound(s) {
    if (s.probe !== "ok" || s.census === null) return true;
    return s.result !== null && s.result.missing.length === 0;
  },
  // Once the successor listens, the probe answers from the boot comparison, never "pending".
  ProbeSettles(s) {
    if (s.phase !== "probed" || s.running === null) return true;
    return s.probe !== "handover_pending";
  },
  // A probe never says "ok" while the node runs a build other than the one activated.
  ProbeReportsRevert(s) {
    return !(s.probe === "ok" && s.census !== null && s.running !== "B");
  },
  // The crash loop always ends on previous: never a fourth start of a dead candidate.
  CrashLoopEndsOnPrevious(s) {
    if (s.previous === null) return true;
    return !(s.crashes > ATTEMPTS && s.current === "B");
  },
  // The marker lives exactly from retarget to the successor's listen or the revert.
  MarkerBoundsHandover(s) {
    if (s.marker !== null) return ["old_stopping", "unit_down", "cand_booting"].includes(s.phase);
    return true;
  },
  // After a revert the previous build runs through current and no stale marker can revert again.
  RevertIsClean(s) {
    if (s.phase !== "prev_listening" && s.phase !== "probed") return true;
    if (s.running !== s.previous || s.running === "B") return true;
    return s.marker === null && s.attempts === 0;
  },
};

// Breadth-first search over every reachable state.
const seen = new Map();
const start = initial();
seen.set(key(start), { parent: null, label: "init" });
const queue = [start];
let states = 0, failures = [];
while (queue.length) {
  const s = queue.shift();
  states += 1;
  for (const [name, holds] of Object.entries(properties)) {
    if (!holds(s)) { failures.push({ property: name, state: s }); }
  }
  if (failures.length && !opts.trace) break;
  for (const [label, t] of successors(s)) {
    const k = key(t);
    if (!seen.has(k)) { seen.set(k, { parent: key(s), label }); queue.push(t); }
  }
}

function pathTo(state) {
  const steps = [];
  let k = key(state);
  while (k) { const entry = seen.get(k); if (!entry.parent) break; steps.unshift(entry.label); k = entry.parent; }
  return steps;
}

const report = { break: BREAK || null, hosts: HOSTS, attempts: ATTEMPTS, states, pass: failures.length === 0, failures: failures.slice(0, 3).map((f) => ({ property: f.property, path: pathTo(f.state), state: f.state })) };
if (opts.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`handover model: ${states} reachable states, ${HOSTS} hosts, ${ATTEMPTS} attempts${BREAK ? `, break=${BREAK}` : ""}`);
  if (report.pass) console.log("all properties hold: " + Object.keys(properties).join(", "));
  for (const f of report.failures) {
    console.log(`\n${f.property} FAILS after ${f.path.length} steps:`);
    f.path.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
    console.log(`  end state: phase=${f.state.phase} current=${f.state.current} previous=${f.state.previous} running=${f.state.running} marker=${f.state.marker} attempts=${f.state.attempts} crashes=${f.state.crashes} hosts=${JSON.stringify(f.state.hosts)} census=${JSON.stringify(f.state.census)} result=${JSON.stringify(f.state.result)} probe=${f.state.probe}`);
  }
}
process.exit(report.pass ? 0 : 1);
