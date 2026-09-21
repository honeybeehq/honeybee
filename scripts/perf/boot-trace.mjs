#!/usr/bin/env node
/**
 * Boot-interval attribution tracer for one Cell/HSR spawn on THIS node.
 *
 * Runs beside the production daemon and never touches it: it polls the process
 * table, TCP tables, the runner files and hived.log on one monotonic clock and
 * writes an event list with microsecond offsets. The daemon's own log lines
 * carry millisecond wall time; they are recorded both as observed (our clock)
 * and as stamped (theirs). Resolution is the poll cadence, reported per source.
 *
 *   node scripts/perf/boot-trace.mjs --data-dir ~/.hive/v2 --match <name-substring> \
 *     [--timeout-ms 90000] [--proc-poll-ms 2] [--net-poll-ms 5] [--file-poll-ms 2] \
 *     [--until session|booted] --out trace.json
 *
 * Linux reads /proc (2 ms process resolution, 5 ms socket resolution). macOS
 * falls back to `ps`/`netstat` (about 30 ms resolution; stated in the output).
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { hostname, loadavg, platform } from "node:os";
import { join } from "node:path";
import { createNetWatcher, createProcWatcher, isLinux } from "./boot-trace-lib.mjs";

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const at = argv.indexOf(name);
  return at < 0 ? fallback : argv[at + 1];
}
const dataDir = opt("--data-dir", join(process.env.HOME ?? "", ".hive", "v2"));
const match = opt("--match", null);
if (!match) throw new Error("--match <bee name or id substring> is required");
const timeoutMs = Number(opt("--timeout-ms", "90000"));
const procPollMs = Number(opt("--proc-poll-ms", "2"));
const netPollMs = Number(opt("--net-poll-ms", "5"));
const filePollMs = Number(opt("--file-poll-ms", "2"));
const until = opt("--until", "session");
const graceMs = Number(opt("--grace-ms", "1500"));
const out = opt("--out", `boot-trace-${Date.now()}.json`);

const t0 = process.hrtime.bigint();
const wall0 = Date.now();
const us = () => Number((process.hrtime.bigint() - t0) / 1000n);
const events = [];
const record = (kind, fields) => { events.push({ us: us(), kind, ...fields }); };

// hived.log tail ------------------------------------------------------------
const logPath = join(dataDir, "hived.log");
let logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
let beeId = null;
let generation = null;
let doneAt = null;
let bootedSeen = false;
function pumpLog() {
  let size;
  try { size = statSync(logPath).size; } catch { return; }
  if (size <= logOffset) return;
  const fd = openSync(logPath, "r");
  const buf = Buffer.alloc(size - logOffset);
  readSync(fd, buf, 0, buf.length, logOffset);
  closeSync(fd);
  logOffset = size;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const op = String(parsed.op ?? "");
    if (beeId == null) {
      if (!op.includes(match)) continue;
      const m = op.match(/bee=([0-9a-f-]{36})/);
      if (!m) continue;
      beeId = m[1];
      record("bee.identified", { beeId, via: op.slice(0, 40) });
    }
    if (!op.includes(beeId)) continue;
    const g = op.match(/gen=(\d+)/);
    if (g && generation == null) generation = Number(g[1]);
    record("hived", { stampedMs: parsed.ts, stampedUs: (parsed.ts - wall0) * 1000, op: op.slice(0, 220) });
    const realBooted = op.startsWith("obs.booted") && !op.includes("synthetic");
    if (realBooted) bootedSeen = true;
    if (doneAt == null && ((until === "session" && op.startsWith("session.recorded")) || (until === "booted" && realBooted))) doneAt = us();
  }
}

// runner files --------------------------------------------------------------
const fileState = new Map();
function firstLine(path) { try { return readFileSync(path, "utf8").split("\n")[0] ?? ""; } catch { return ""; } }
function readRange(path, from, to) {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(Math.min(to - from, 4096));
    readSync(fd, buf, 0, buf.length, from);
    closeSync(fd);
    return buf.toString("utf8");
  } catch { return ""; }
}
function pumpFiles() {
  if (beeId == null) return;
  const gens = generation == null ? [1, 2, 3, 4, 5] : [generation];
  const paths = [];
  for (const g of gens) {
    const base = join(dataDir, "runners", `${beeId}.${g}`);
    paths.push([`config.g${g}`, `${base}.json`], [`status.g${g}`, `${base}.status.json`], [`observations.g${g}`, `${base}.observations.jsonl`]);
  }
  paths.push(["stderr", join(dataDir, "session-logs", `${beeId}.stderr.log`)], ["session-log", join(dataDir, "session-logs", `${beeId}.jsonl`)]);
  for (const [label, path] of paths) {
    let st;
    try { st = statSync(path); } catch { continue; }
    const prev = fileState.get(label);
    const extra = {};
    if (label.startsWith("status")) { try { extra.status = JSON.parse(readFileSync(path, "utf8")); } catch {} }
    if (prev == null) {
      fileState.set(label, st.size);
      if (!label.startsWith("status") && !label.startsWith("config")) extra.first = firstLine(path).slice(0, 200);
      record("file.appeared", { label, size: st.size, ...extra });
    } else if (st.size !== prev) {
      fileState.set(label, st.size);
      if (!label.startsWith("status")) extra.tail = readRange(path, prev, st.size).slice(0, 200);
      record("file.grew", { label, from: prev, to: st.size, ...extra });
    }
  }
}

// main loop -----------------------------------------------------------------
const procs = createProcWatcher(record);
const net = createNetWatcher(record, procs);
record("trace.started", { host: hostname(), platform: platform(), dataDir, match, load: loadavg(), wall0, procPollMs: isLinux ? procPollMs : "ps-loop", netPollMs: isLinux ? netPollMs : "netstat-loop", filePollMs });
process.stdout.write(`boot-trace armed on ${hostname()} for match=${match}\n`);

let lastProc = 0, lastNet = 0, lastFile = 0;
const deadline = us() + timeoutMs * 1000;
function loop() {
  const now = us();
  if (isLinux) {
    if (now - lastProc >= procPollMs * 1000) { lastProc = now; procs.poll(); }
    if (now - lastNet >= netPollMs * 1000) { lastNet = now; net.poll(); }
  } else {
    procs.poll();
    net.poll();
  }
  if (now - lastFile >= filePollMs * 1000) { lastFile = now; pumpLog(); pumpFiles(); }
  if (doneAt != null && now - doneAt >= graceMs * 1000) return finish("done");
  if (now >= deadline) return finish("timeout");
  setImmediate(loop);
}
function finish(reason) {
  pumpLog();
  pumpFiles();
  const report = { host: hostname(), platform: platform(), wall0, reason, beeId, generation, bootedSeen, loadAfter: loadavg(), events, liveTracedProcesses: procs.snapshot() };
  writeFileSync(out, JSON.stringify(report, null, 1));
  process.stdout.write(`boot-trace finished (${reason}) bee=${beeId} events=${events.length} -> ${out}\n`);
  process.exit(0);
}
setImmediate(loop);
