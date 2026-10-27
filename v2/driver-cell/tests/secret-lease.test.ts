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
for (const mode of ["kill", "stop", "normal", "deadline"] as const) {
  test(`secret runner lease kills child and grandchild on ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "secret-lease-"));
    const paths = cellPaths(root, "wrap", "repo", "c1");
    mkdirSync(paths.spaceDir, { recursive: true });
    const marker = join(paths.spaceDir, "pids");
    const childCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,grandchild.pid]));process.on('SIGTERM',()=>{});${mode === "normal" ? "setTimeout(()=>process.exit(0),100)" : "setInterval(()=>{},1000)"}`;
    const source = `import {runCellExec} from ${JSON.stringify(new URL("../src/exec.ts", import.meta.url).href)};await runCellExec(${JSON.stringify(paths)},{argv:${JSON.stringify([process.execPath,"-e",childCode])},sandbox:false,nodeKind:'satellite',timeoutMs:${mode === "kill" ? 15000 : 1000},secretEnv:{SYNTHETIC_TOKEN:'synthetic-lease-only'}});`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore" });
    const exited = new Promise<void>(resolve => owner.once("exit", () => resolve()));
    let pids: number[] = [];
    try {
      await until(() => existsSync(marker));
      pids = JSON.parse(readFileSync(marker, "utf8"));
      assert.ok(pids.every(running));
      const start = Date.now();
      if (mode === "kill") owner.kill("SIGKILL");
      if (mode === "stop") owner.kill("SIGSTOP");
      await until(() => pids.every(pid => !running(pid)), mode === "normal" ? 3000 : 2000);
      console.log(JSON.stringify({ mode, cleanupMs: Date.now() - start, childAndGrandchildStopped: true }));
    } finally {
      if (mode === "stop") owner.kill("SIGCONT");
      owner.kill("SIGKILL");
      await exited;
      for (const pid of pids) if (running(pid)) process.kill(pid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });
}
