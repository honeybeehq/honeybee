import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProcess, sameProcess, type ProcessIdentity } from "../../harness/src/processIdentity.ts";
import { processIdentityValue } from "../../core/src/processIdentity.ts";
import { CELL_REPO_DIAGNOSTIC_BYTES, CELL_REPO_REPORT_BYTES, CELL_REPO_REQUEST_BYTES, cellRepoFailure, CellRepoRefusal, parseCellRepoInspection, parseCellRepoRequest, type CellRepoIdentity, type CellRepoInspection, type CellRepoRequest } from "./cellRepoProtocol.ts";

export function cellRepoBackend(sandboxed: boolean): "confined" | "unconfined" {
  return sandboxed ? "confined" : "unconfined";
}

export interface CellRepoOptions {
  deadlineMs?: number;
  helperPath?: string;
  onStarted?: (identity: ProcessIdentity) => void;
  unconfined: (identity: CellRepoIdentity, request: CellRepoRequest) => Promise<CellRepoInspection>;
}

export async function runCellRepoBatch(identity: CellRepoIdentity, request: CellRepoRequest, options: CellRepoOptions): Promise<CellRepoInspection> {
  const validated = parseCellRepoRequest(request);
  if (cellRepoBackend(identity.sandboxed) === "unconfined") return parseCellRepoInspection(await options.unconfined(identity, validated));
  const timeoutMs = options.deadlineMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new CellRepoRefusal("deadline");
  const supervisor = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../dist/v2/cell-repo-supervisor.js" : "./cell-repo-supervisor.js", import.meta.url));
  let node: string;
  try {
    node = await realpath(process.execPath);
    for (const path of [node, supervisor]) {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) throw new CellRepoRefusal("unavailable");
    }
    const manifest = JSON.parse(await readFile(join(dirname(supervisor), "cell-repo-manifest.json"), "utf8"));
    if (manifest.version !== 1 || manifest.files?.[basename(supervisor)] !== createHash("sha256").update(await readFile(supervisor)).digest("hex")) throw new CellRepoRefusal("unavailable");
  } catch { throw new CellRepoRefusal("unavailable"); }
  const input = JSON.stringify({ identity, request: validated, timeoutMs, helperPath: options.helperPath }) + "\n";
  if (Buffer.byteLength(input) > CELL_REPO_REQUEST_BYTES) throw new CellRepoRefusal("invalid_request");
  return new Promise((resolve, reject) => {
    const child = spawn(node, [supervisor], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const observed = child.pid === undefined ? null : inspectProcess(child.pid);
    const owned = observed?.kind === "present" && observed.pgid === child.pid ? { pid: observed.pid, birth: observed.birth, bootId: observed.bootId } : null;
    let failure: CellRepoRefusal | null = null;
    let settled = false;
    const output: Buffer[] = [];
    let bytes = 0;
    let diagnostics = 0;
    let sandboxIdentity: ProcessIdentity | null = null;
    let prefix = "";
    let started = false;
    const kill = () => {
      const current = owned ? inspectProcess(owned.pid) : null;
      if (owned && current && sameProcess(owned, current) && current.pgid === owned.pid) {
        try { process.kill(-owned.pid, "SIGKILL"); } catch {}
      } else if (!owned) child.kill("SIGKILL");
      const sandbox = sandboxIdentity ? inspectProcess(sandboxIdentity.pid) : null;
      if (sandboxIdentity && sandbox && sameProcess(sandboxIdentity, sandbox) && sandbox.pgid === sandboxIdentity.pid) {
        try { process.kill(-sandboxIdentity.pid, "SIGKILL"); } catch {}
      }
    };
    const stop = (code: "deadline" | "output_limit" | "unavailable") => { failure ??= new CellRepoRefusal(code); child.stdin.destroy(); kill(); };
    const timer = setTimeout(() => stop("deadline"), timeoutMs);
    if (!owned) stop("unavailable");
    else { try { options.onStarted?.(owned); } catch {} }
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > CELL_REPO_REPORT_BYTES) stop("output_limit");
      else output.push(chunk);
      if (!started) {
        const end = chunk.indexOf(10);
        prefix += chunk.subarray(0, end < 0 ? chunk.length : end).toString("utf8");
        if (Buffer.byteLength(prefix) > 4096) { stop("output_limit"); return; }
        if (end >= 0) {
          started = true;
          try {
            const frame = JSON.parse(prefix);
            sandboxIdentity = processIdentityValue(frame.started);
            if (!sandboxIdentity || Object.keys(frame).length !== 1) throw new Error();
            const observed = inspectProcess(sandboxIdentity.pid);
            if (observed.kind === "present" && (!sameProcess(sandboxIdentity, observed) || observed.ppid !== owned?.pid || observed.pgid !== sandboxIdentity.pid)) throw new Error();
          } catch { stop("unavailable"); }
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > CELL_REPO_DIAGNOSTIC_BYTES) stop("output_limit"); });
    child.once("error", () => { failure ??= new CellRepoRefusal("unavailable"); kill(); });
    child.stdin.on("error", () => { if (!settled) stop("unavailable"); });
    child.stdin.write(input);
    child.once("close", code => {
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      kill();
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new CellRepoRefusal("unavailable")); return; }
      try {
        const frames = Buffer.concat(output).toString("utf8").split("\n");
        if (frames.length === 2) {
          const start = JSON.parse(frames.shift()!);
          if (Object.keys(start).length !== 1 || !processIdentityValue(start.started)) throw new CellRepoRefusal("invalid_output");
        }
        if (frames.length !== 1) throw new CellRepoRefusal("invalid_output");
        const message = JSON.parse(frames[0]!);
        if (cellRepoFailure(message.failure)) throw new CellRepoRefusal(cellRepoFailure(message.failure)!);
        resolve(parseCellRepoInspection(message.result));
      } catch (error) { reject(error instanceof CellRepoRefusal ? error : new CellRepoRefusal("invalid_output")); }
    });
  });
}
