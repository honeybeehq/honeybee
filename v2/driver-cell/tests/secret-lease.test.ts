import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
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
for (const mode of ["kill", "stop", "normal", "deadline", "cancel-frozen", "supervisor-kill"] as const) {
  test(`secret runner lease kills child and grandchild on ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "secret-lease-"));
    const paths = cellPaths(root, "wrap", "repo", "c1");
    mkdirSync(paths.spaceDir, { recursive: true });
    const marker = join(paths.spaceDir, "pids");
    const childCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,grandchild.pid]));process.on('SIGTERM',()=>{});${mode === "normal" ? "setTimeout(()=>process.exit(0),100)" : "setInterval(()=>{},1000)"}`;
    const supervisorMarker = join(paths.spaceDir, "supervisor");
    const source = `import {writeFileSync} from "node:fs";const controller=new AbortController();process.on("SIGUSR1",()=>controller.abort());import {runCellExec} from ${JSON.stringify(new URL("../src/exec.ts", import.meta.url).href)};await runCellExec(${JSON.stringify(paths)},{argv:${JSON.stringify([process.execPath,"-e",childCode])},sandbox:false,nodeKind:'satellite',timeoutMs:${mode === "kill" || mode === "cancel-frozen" || mode === "supervisor-kill" ? 15000 : 1000},signal:controller.signal,secretEnv:{SYNTHETIC_TOKEN:'synthetic-lease-only'}}, id=>writeFileSync(${JSON.stringify(supervisorMarker)},String(id.pid)));`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore" });
    let ownerExited = false;
    const exited = new Promise<void>(resolve => owner.once("exit", () => { ownerExited = true; resolve(); }));
    let pids: number[] = [];
    let supervisorPid = 0;
    try {
      await until(() => existsSync(marker));
      pids = JSON.parse(readFileSync(marker, "utf8"));
      assert.ok(pids.every(running));
      const start = Date.now();
      if (mode === "supervisor-kill") {
        supervisorPid = Number(readFileSync(supervisorMarker, "utf8"));
        process.kill(-supervisorPid, "SIGKILL");
      }
      if (mode === "cancel-frozen") {
        supervisorPid = Number(readFileSync(supervisorMarker, "utf8"));
        process.kill(supervisorPid, "SIGSTOP");
        owner.kill("SIGUSR1");
      }
      if (mode === "kill") owner.kill("SIGKILL");
      if (mode === "stop") owner.kill("SIGSTOP");
      await until(() => pids.every(pid => !running(pid)), mode === "normal" ? 3000 : 2000);
      if (mode === "supervisor-kill") await until(() => ownerExited);
      console.log(JSON.stringify({ mode, cleanupMs: Date.now() - start, childAndGrandchildStopped: true }));
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
