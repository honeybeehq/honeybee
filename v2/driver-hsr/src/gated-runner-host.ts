import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { exactProcessBirth } from "../../harness/src/processIdentity.ts";
import { runnerStateFiles } from "../../harness/src/statePath.ts";
import { canonicalDigest, type JsonValue } from "../../../src/comb/canonical.ts";
import type { RunnerHostConfig, RunnerStatus } from "./runner-host.ts";

export function runGatedRunnerHost(cfg: RunnerHostConfig, sessionLogLine: (line: string) => string): void {
  runnerStateFiles(cfg);
  const start = cfg.executionStart, owner = cfg.executionOwner;
  const birth = exactProcessBirth(process.pid);
  if (!start || !owner || !process.send || !birth || process.ppid !== owner.pid || exactProcessBirth(owner.pid) !== owner.birth || start.beeId !== cfg.beeId || start.runtimeGeneration !== cfg.generation) throw new Error("Fenced host requires its exact inherited owner channel");
  const bindingDigest = canonicalDigest(start as unknown as JsonValue);
  let child: ChildProcess | null = null, consumed = false, finished = false;
  const report = (frame: Record<string, unknown>): void => { if (process.connected) process.send?.(frame,()=>{}); };
  mkdirSync(dirname(cfg.sessionLogPath), { recursive: true });
  mkdirSync(dirname(cfg.observationLogPath), { recursive: true });
  writeFileSync(cfg.observationLogPath, "", { flag: "a" });
  const status: RunnerStatus = { hostPid: process.pid, hostBirth: birth, beeId: cfg.beeId, generation: cfg.generation, executionIntentId: start.intentId, executionDigest: bindingDigest, executionState: "waiting", at: Date.now() };
  const persist = (): void => { status.at = Date.now(); writeFileSync(cfg.statusPath, JSON.stringify(status)); };
  const finish = (patch: Partial<RunnerStatus>): void => {
    if (finished) return; finished = true;
    Object.assign(status, patch); persist(); server.close(); rmSync(cfg.socketPath, { force: true }); process.exit(0);
  };
  const write = (line: string): void => {
    if (!child || !consumed || !child.stdin?.writable) return;
    appendFileSync(cfg.sessionLogPath, line + "\n"); child.stdin.write(line + "\n");
  };
  rmSync(cfg.socketPath, { force: true });
  const server = createServer(socket => {
    let rest = ""; socket.setEncoding("utf8"); socket.on("error", () => {});
    socket.on("data", data => {
      const lines = (rest + data).split("\n"); rest = lines.pop() ?? "";
      for (const line of lines) try { const frame = JSON.parse(line); if (frame.op === "write" && typeof frame.line === "string") write(frame.line); } catch {}
    });
  });
  server.on("error", () => { if (!child) finish({ spawnError: "Fenced host control socket unavailable", exited: true }); });
  server.listen(cfg.socketPath, () => {
    persist();
    report({ op: "execution_ready", intentId: start.intentId, bindingDigest, host: { pid: process.pid, birth } });
  });
  process.on("disconnect", () => { if (!consumed) finish({ executionState: "cancelled", exited: true }); });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { if (!consumed) finish({ executionState: "cancelled", exited: true }); });
  process.on("message", (value: unknown) => {
    if (!value || typeof value !== "object" || consumed || finished) return;
    const frame = value as Record<string, unknown>, host = frame.host as { pid?: unknown; birth?: unknown } | undefined;
    if (Object.keys(frame).sort().join(",") !== "bindingDigest,host,intentId,op" || frame.op !== "execution_release" || frame.intentId !== start.intentId || frame.bindingDigest !== bindingDigest || host?.pid !== process.pid || host.birth !== birth || exactProcessBirth(process.pid) !== birth || process.ppid !== owner.pid || exactProcessBirth(owner.pid) !== owner.birth) {
      if (frame.op === "execution_release") report({ op: "execution_release_refused", intentId: start.intentId, reason: "binding_mismatch" });
      return;
    }
    consumed = true; status.executionState = "released"; persist();
    child = spawn(cfg.command, cfg.args, { cwd: cfg.cwd, env: cfg.env, stdio: ["pipe","pipe","pipe"] });
    child.once("spawn", () => {
      const agentPid = child!.pid, agentBirth = agentPid ? exactProcessBirth(agentPid) : null;
      if (!agentPid || !agentBirth) { status.spawnError = "Agent process identity unavailable"; persist(); return; }
      Object.assign(status, { agentPid, agentBirth, executionState: "started" }); persist();
      report({ op: "execution_started", intentId: start.intentId, bindingDigest, host: { pid: process.pid, birth }, agent: { pid: agentPid, birth: agentBirth } });
      for (const line of cfg.bootLines) write(line);
    });
    child.once("error", () => finish({ spawnError: "Agent fork failed", exited: true, exitCode: null, exitSignal: null }));
    child.once("close", (code, signal) => finish({ exited: true, exitCode: code, exitSignal: signal ?? null }));
    child.stdin?.on("error", () => {});
    let rest = ""; child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n"); rest = lines.pop() ?? "";
      for (const raw of lines) { const line = raw.replace(/\r$/, ""); if (!line.trim()) continue; appendFileSync(cfg.observationLogPath,line+"\n"); appendFileSync(cfg.sessionLogPath,sessionLogLine(line)+"\n"); }
    });
    child.stderr?.on("data", data => appendFileSync(cfg.sidecarPath, data));
  });
}
