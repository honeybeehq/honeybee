/**
 * Shared process-table and TCP-table watchers for the boot tracers.
 * Linux reads /proc directly (cheap enough for a 2 ms cadence); macOS falls
 * back to `ps` and `netstat` (tens of milliseconds per pass, stated in output).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { platform } from "node:os";

export const isLinux = platform() === "linux";
export const INTERESTING = /runner-host|bwrap|sandbox-exec|claude|codex|grok|kimi|opencode|gateway-shim|apiary-mcp|foundation|(^|\/| )git( |$)|(^|\/| )node( |$)|(^|\/| )sh( |$)|bash|python|uv\b|npx|bun/;

export function createProcWatcher(record, filter = INTERESTING) {
  const known = new Map();
  let baselineDone = false;
  function readLinux() {
    const seen = new Set();
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      seen.add(pid);
      if (known.has(pid)) continue;
      let cmd = "";
      let ppid = -1;
      try { cmd = readFileSync(`/proc/${name}/cmdline`).toString("utf8").replace(/\0/g, " ").trim(); } catch { continue; }
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } catch {}
      known.set(pid, { ppid, cmd });
      if (baselineDone && cmd && filter.test(cmd)) record("proc.start", { pid, ppid, cmd: cmd.slice(0, 400) });
    }
    for (const pid of [...known.keys()]) {
      if (seen.has(pid)) continue;
      const info = known.get(pid);
      known.delete(pid);
      if (baselineDone && info.cmd && filter.test(info.cmd)) record("proc.exit", { pid, cmd: info.cmd.slice(0, 120) });
    }
  }
  function readMac() {
    const p = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const seen = new Set();
    for (const line of p.stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      seen.add(pid);
      if (known.has(pid)) continue;
      const cmd = m[3];
      known.set(pid, { ppid: Number(m[2]), cmd });
      if (baselineDone && filter.test(cmd)) record("proc.start", { pid, ppid: Number(m[2]), cmd: cmd.slice(0, 400) });
    }
    for (const pid of [...known.keys()]) {
      if (seen.has(pid)) continue;
      const info = known.get(pid);
      known.delete(pid);
      if (baselineDone && filter.test(info.cmd)) record("proc.exit", { pid, cmd: info.cmd.slice(0, 120) });
    }
  }
  const read = isLinux ? readLinux : readMac;
  read();
  baselineDone = true;
  return {
    poll: read,
    known,
    tracedPids: () => [...known.entries()].filter(([, i]) => filter.test(i.cmd)).map(([pid]) => pid),
    cmdOf: (pid) => known.get(pid)?.cmd ?? null,
    snapshot: () => [...known.entries()].filter(([, i]) => filter.test(i.cmd)).map(([pid, i]) => ({ pid, ppid: i.ppid, cmd: i.cmd.slice(0, 300) })),
  };
}

const TCP_STATES = { "01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV", "04": "FIN_WAIT1", "05": "FIN_WAIT2", "06": "TIME_WAIT", "07": "CLOSE", "08": "CLOSE_WAIT", "09": "LAST_ACK", "0A": "LISTEN", "0B": "CLOSING" };
function hexAddr(s) {
  const [addr, port] = s.split(":");
  const p = parseInt(port, 16);
  if (addr.length === 8) {
    const b = Buffer.from(addr, "hex");
    return `${b[3]}.${b[2]}.${b[1]}.${b[0]}:${p}`;
  }
  const words = [];
  for (let i = 0; i < 32; i += 8) {
    const w = addr.slice(i, i + 8);
    words.push(w.slice(6, 8) + w.slice(4, 6), w.slice(2, 4) + w.slice(0, 2));
  }
  const ip = words.map((w) => w.replace(/^0+/, "") || "0").join(":");
  // v4-mapped v6 (::ffff:a.b.c.d)
  if (ip.startsWith("0:0:0:0:0:ffff:")) {
    const hi = parseInt(words[6], 16), lo = parseInt(words[7], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}:${p}`;
  }
  return `[${ip}]:${p}`;
}
function pidForInode(inode, candidates) {
  for (const pid of candidates) {
    let fds;
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (link === `socket:[${inode}]`) return pid;
    }
  }
  return null;
}

export function createNetWatcher(record, procs) {
  const knownSockets = new Set();
  let baselineDone = false;
  const pending = new Map(); // inode -> {local, remote, state, firstUs}
  function readLinux() {
    for (const table of ["tcp", "tcp6"]) {
      let text;
      try { text = readFileSync(`/proc/net/${table}`, "utf8"); } catch { continue; }
      for (const line of text.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 10) continue;
        const state = TCP_STATES[cols[3]] ?? cols[3];
        if (state === "LISTEN" || state === "TIME_WAIT") continue;
        const inode = cols[9];
        const key = `${cols[1]}>${cols[2]}:${inode}`;
        if (knownSockets.has(key)) continue;
        knownSockets.add(key);
        if (!baselineDone) continue;
        const local = hexAddr(cols[1]);
        const remote = hexAddr(cols[2]);
        const pid = inode === "0" ? null : pidForInode(inode, procs.tracedPids());
        record("net.new", { local, remote, state, pid, cmd: pid ? procs.cmdOf(pid)?.slice(0, 80) : null });
      }
    }
  }
  function readMac() {
    const p = spawnSync("netstat", ["-anv", "-p", "tcp"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const line of p.stdout.split("\n")) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 9 || !cols[0].startsWith("tcp")) continue;
      const [local, remote, state] = [cols[3], cols[4], cols[5]];
      if (state === "LISTEN" || state === "TIME_WAIT" || state === "CLOSED") continue;
      const pid = Number(cols[8]);
      const key = `${local}>${remote}:${pid}`;
      if (knownSockets.has(key)) continue;
      knownSockets.add(key);
      if (!baselineDone) continue;
      const cmd = procs.cmdOf(pid);
      if (cmd == null || !INTERESTING.test(cmd)) continue;
      record("net.new", { local, remote, state, pid, cmd: cmd.slice(0, 80) });
    }
  }
  const read = isLinux ? readLinux : readMac;
  read();
  baselineDone = true;
  return { poll: read };
}
