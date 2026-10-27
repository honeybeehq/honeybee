import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellPaths } from "../src/layout.ts";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, bound = 3000) {
  const end = Date.now() + bound;
  while (!check() && Date.now() < end) await wait(20);
  assert.ok(check(), "bounded process cleanup");
}
function running(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.startsWith("Z");
    return true;
  } catch { return false; }
}
function hostPids(launcher: number, namespacePids: number[]): number[] {
  const descendants: number[] = [];
  const visit = (pid: number) => {
    descendants.push(pid);
    try {
      for (const value of readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean)) visit(Number(value));
    } catch {}
  };
  visit(launcher);
  return namespacePids.map(local => {
    const match = descendants.find(pid => {
      try { return Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^NSpid:\s+(.+)$/m)?.[1]?.trim().split(/\s+/).at(-1)) === local; } catch { return false; }
    });
    assert.ok(match, "own descendant namespace PID maps to host PID");
    return match;
  });
}
for (const sandbox of process.platform === "linux" ? [false, null] : [false]) for (const detached of process.platform === "linux" ? [false, true] : [false]) for (const mode of ["kill", "stop", "normal", "deadline", "cancel-frozen", "supervisor-kill", "supervisor-only-kill", "init-only-kill", "owner-and-init-kill"] as const) {
  test(`secret runner lease kills child and grandchild on ${mode} (detached=${detached}, sandbox=${sandbox})`, async () => {
    if ((mode === "init-only-kill" || mode === "owner-and-init-kill") && process.platform !== "linux") return;
    const root = mkdtempSync(join(tmpdir(), "secret-lease-"));
    const paths = cellPaths(root, "wrap", "repo", "c1");
    mkdirSync(paths.spaceDir, { recursive: true });
    const marker = join(paths.spaceDir, "pids");
    const normalExitMarker = join(paths.spaceDir, "finish");
    const grandchildMarker = join(paths.spaceDir, "grandchild");
    const grandchildCode = `const fs=require('node:fs');const pid=process.platform==='linux'?Number(fs.readFileSync('/proc/self/stat','utf8').split(' ')[0]):process.pid;fs.writeFileSync(${JSON.stringify(grandchildMarker)},String(pid));setInterval(()=>{},1000)`;
    const childCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:'ignore',detached:${detached}});process.on('SIGTERM',()=>{});const ready=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(grandchildMarker)}))return;clearInterval(ready);const pid=process.platform==='linux'?Number(fs.readFileSync('/proc/self/stat','utf8').split(' ')[0]):process.pid;fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([pid,Number(fs.readFileSync(${JSON.stringify(grandchildMarker)},'utf8')),...(process.platform==='linux'?[1]:[])]));${mode === "normal" ? `setInterval(()=>{if(fs.existsSync(${JSON.stringify(normalExitMarker)}))process.exit(0)},10)` : ""}},10);setInterval(()=>{},1000)`;
    const supervisorMarker = join(paths.spaceDir, "supervisor");
    const source = `import {writeFileSync} from "node:fs";const controller=new AbortController();process.on("SIGUSR1",()=>controller.abort());import {runCellExec} from ${JSON.stringify(new URL("../src/exec.ts", import.meta.url).href)};await runCellExec(${JSON.stringify(paths)},{argv:${JSON.stringify([process.execPath,"-e",childCode])},sandbox:${JSON.stringify(sandbox)},nodeKind:'satellite',timeoutMs:${mode === "kill" || mode === "cancel-frozen" || mode === "supervisor-kill" || mode === "supervisor-only-kill" || mode === "init-only-kill" || mode === "owner-and-init-kill" ? 15000 : 1000},signal:controller.signal,secretEnv:{SYNTHETIC_TOKEN:'synthetic-lease-only'}}, id=>writeFileSync(${JSON.stringify(supervisorMarker)},String(id.pid)));`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore" });
    let ownerExited = false;
    const exited = new Promise<void>(resolve => owner.once("exit", () => { ownerExited = true; resolve(); }));
    let pids: number[] = [];
    let supervisorPid = 0;
    try {
      await until(() => existsSync(marker));
      const localPids: number[] = JSON.parse(readFileSync(marker, "utf8"));
      pids = process.platform === "linux" ? hostPids(Number(readFileSync(supervisorMarker, "utf8")), localPids) : localPids;
      assert.ok(pids.every(running));
      const start = Date.now();
      if (mode === "normal") writeFileSync(normalExitMarker, "1");
      if (mode === "owner-and-init-kill") { owner.kill("SIGKILL"); process.kill(pids[2]!, "SIGKILL"); }
      if (mode === "init-only-kill") process.kill(pids[2]!, "SIGKILL");
      if (mode === "supervisor-kill" || mode === "supervisor-only-kill") {
        supervisorPid = Number(readFileSync(supervisorMarker, "utf8"));
        process.kill(mode === "supervisor-only-kill" ? supervisorPid : -supervisorPid, "SIGKILL");
      }
      if (mode === "cancel-frozen") {
        supervisorPid = Number(readFileSync(supervisorMarker, "utf8"));
        process.kill(supervisorPid, "SIGSTOP");
        owner.kill("SIGUSR1");
      }
      if (mode === "kill") owner.kill("SIGKILL");
      if (mode === "stop") owner.kill("SIGSTOP");
      await until(() => pids.every(pid => !running(pid)), mode === "supervisor-only-kill" ? 4000 : mode === "normal" ? 3000 : 2000);
      if (mode === "supervisor-kill" || mode === "supervisor-only-kill" || mode === "init-only-kill") await until(() => ownerExited);
      console.log(JSON.stringify({ mode, detached, cleanupMs: Date.now() - start, childAndGrandchildStopped: true }));
    } finally {
      if (supervisorPid && running(supervisorPid)) process.kill(supervisorPid, "SIGCONT");
      if (mode === "stop") owner.kill("SIGCONT");
      owner.kill("SIGKILL");
      await exited;
      for (const pid of pids) if (running(pid)) process.kill(pid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });
}
