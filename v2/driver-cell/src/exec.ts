/**
 * Sandboxed retained-Cell exec. Argv only, no shell. Caller-host env is not
 * forwarded. Output/time bounded. Process-group stop; the Promise does not
 * settle until the child is reaped. Never a B5 command.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  CELL_EXEC_MAX_OUTPUT_BYTES,
  clampCellExecTimeout,
} from "../../core/src/cellMove.ts";
import { pidAlive, processStartTimeMs } from "../../driver-hsr/src/psutil.ts";
import { defaultWritablePaths, sandboxEnabled, wrapWithSandbox, type NodeKind } from "./sandbox.ts";
import type { CellPaths } from "./layout.ts";

export interface CellExecSpec {
  argv: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  sandbox: boolean | null;
  nodeKind: NodeKind;
}

export interface CellExecSpawned {
  pid: number;
  pidStartedAt: number;
}

export interface CellExecOutcome {
  status: "ok" | "nonzero" | "timeout" | "interrupted";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timeoutMs: number;
  pid: number | null;
  pidStartedAt: number | null;
}

export function sanitizedCellExecEnv(): Record<string, string> {
  const path = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    PATH: path,
    HOME: homedir(),
    TMPDIR: tmpdir(),
    LANG: process.env.LANG ?? "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Index of the first byte that begins an incomplete UTF-8 sequence at the
 * end of `buf`. Complete characters — including valid multibyte suffixes —
 * are kept. Invalid leads stay so `toString("utf8")` can emit U+FFFD.
 */
export function utf8DecodableEnd(buf: Buffer): number {
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const lead = buf[i]!;
    if (lead <= 0x7f) {
      i += 1;
      continue;
    }
    let need = 0;
    if (lead >= 0xc2 && lead <= 0xdf) need = 2;
    else if (lead >= 0xe0 && lead <= 0xef) need = 3;
    else if (lead >= 0xf0 && lead <= 0xf4) need = 4;
    if (need === 0) {
      i += 1;
      continue;
    }
    if (i + need > n) return i;
    let valid = true;
    for (let k = 1; k < need; k++) {
      if ((buf[i + k]! & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      i += 1;
      continue;
    }
    i += need;
  }
  return n;
}

function decodeUtf8DropIncomplete(buf: Buffer): string {
  const end = utf8DecodableEnd(buf);
  if (end <= 0) return "";
  return buf.subarray(0, end).toString("utf8");
}

function trimEncodedToCap(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = Buffer.byteLength(text, "utf8");
  if (encoded <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  const slice = buf.subarray(0, maxBytes);
  return decodeUtf8DropIncomplete(slice);
}

/** One 1 MiB budget shared by stdout and stderr: raw intake and encoded output. */
export class OutputBudget {
  rawUsed = 0;
  encodedUsed = 0;
  truncated = false;

  takeRaw(chunk: Buffer): Buffer {
    if (chunk.length === 0) return chunk.subarray(0, 0);
    const room = CELL_EXEC_MAX_OUTPUT_BYTES - this.rawUsed;
    if (room <= 0) {
      this.truncated = true;
      return chunk.subarray(0, 0);
    }
    const accepted = chunk.subarray(0, Math.min(room, chunk.length));
    this.rawUsed += accepted.length;
    if (accepted.length < chunk.length) this.truncated = true;
    return accepted;
  }

  takeEncoded(text: string): string {
    if (text.length === 0) return "";
    const room = CELL_EXEC_MAX_OUTPUT_BYTES - this.encodedUsed;
    const kept = trimEncodedToCap(text, room);
    this.encodedUsed += Buffer.byteLength(kept, "utf8");
    if (kept !== text) this.truncated = true;
    return kept;
  }
}

export class OutputCap {
  private chunks: Buffer[] = [];
  private readonly budget: OutputBudget;
  private decoded: string | null = null;
  used = 0;

  constructor(budget = new OutputBudget()) {
    this.budget = budget;
  }

  get truncated(): boolean {
    return this.budget.truncated;
  }

  push(chunk: Buffer): void {
    const accepted = this.budget.takeRaw(chunk);
    if (accepted.length === 0) return;
    this.used += accepted.length;
    this.chunks.push(Buffer.from(accepted));
    this.decoded = null;
  }

  text(): string {
    if (this.decoded != null) return this.decoded;
    if (this.chunks.length === 0) {
      this.decoded = "";
      return "";
    }
    this.decoded = this.budget.takeEncoded(decodeUtf8DropIncomplete(Buffer.concat(this.chunks)));
    return this.decoded;
  }
}

/** Drop an incomplete tail, replace malformed bytes, and cap encoded output at 1 MiB. */
export function decodeCappedUtf8(buf: Buffer): string {
  const cap = new OutputCap();
  cap.push(buf);
  return cap.text();
}

/**
 * Space-relative cwd only. Realpath both sides so a symlink inside the space
 * that points at a sibling outside cannot pass.
 */
export function containedExecCwd(spaceDir: string, requested?: string): string {
  const realRoot = realpathSync(resolve(spaceDir));
  if (requested == null || requested.length === 0 || requested === ".") return realRoot;
  if (isAbsolute(requested)) {
    throw new Error(`cell.exec cwd must be space-relative, got absolute '${requested}'`);
  }
  const parts = requested.split(/[/\\]/).filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error(`cell.exec cwd '${requested}' escapes the Cell space`);
  }
  const candidate = resolve(realRoot, ...parts);
  const unresolvedRel = relative(realRoot, candidate);
  if (unresolvedRel.startsWith(`..${sep}`) || unresolvedRel === ".." || isAbsolute(unresolvedRel)) {
    throw new Error(`cell.exec cwd '${requested}' escapes the Cell space`);
  }
  if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
    const realCandidate = realpathSync(candidate);
    const rel = relative(realRoot, realCandidate);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      throw new Error(`cell.exec cwd '${requested}' escapes the Cell space`);
    }
    return realCandidate;
  }
  if (!existsSync(candidate)) {
    throw new Error(`cell.exec cwd '${requested}' does not exist inside the Cell space`);
  }
  const realCandidate = realpathSync(candidate);
  const rel = relative(realRoot, realCandidate);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`cell.exec cwd '${requested}' escapes the Cell space`);
  }
  return realCandidate;
}

function killTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
}

function closesWithin(closed: Promise<number | null>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveClosed) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveClosed(false);
    }, timeoutMs);
    void closed.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveClosed(true);
    });
  });
}

async function terminateAndReap(
  child: ChildProcess,
  pid: number,
  reaped: { reaped: boolean },
  closed: Promise<number | null>,
): Promise<void> {
  if (reaped.reaped) return;
  if (pid > 0) killTree(pid, "SIGTERM");
  const closedAfterTerm = await closesWithin(closed, 1_000);
  if (!closedAfterTerm && !reaped.reaped && pid > 0 && pidAlive(pid)) {
    killTree(pid, "SIGKILL");
  }
  if (!reaped.reaped) await closed;
}

export async function runCellExec(
  paths: CellPaths,
  spec: CellExecSpec,
  onSpawned?: (identity: CellExecSpawned) => void,
): Promise<CellExecOutcome> {
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || spec.argv.some((a) => typeof a !== "string")) {
    throw new Error("cell.exec argv must be a non-empty string array");
  }
  const timeoutMs = clampCellExecTimeout(spec.timeoutMs);
  const cwd = containedExecCwd(paths.spaceDir, spec.cwd);
  const [command, ...args] = spec.argv;
  const env = {
    ...sanitizedCellExecEnv(),
    HIVE_CELL: "1",
    HIVE_CELL_SPACE: paths.spaceName,
  };
  let wrappedCommand = command as string;
  let wrappedArgs = args;
  if (sandboxEnabled(spec.nodeKind, spec.sandbox)) {
    const wrapped = wrapWithSandbox(
      { cellDir: paths.wrapperDir, writablePaths: defaultWritablePaths() },
      command,
      args,
      paths.sandboxProfilePath,
    );
    if (wrapped.profile) writeFileSync(paths.sandboxProfilePath, wrapped.profile);
    wrappedCommand = wrapped.command;
    wrappedArgs = wrapped.args;
  }
  const child = spawn(wrappedCommand, wrappedArgs, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const reaped = { reaped: false, code: null as number | null };
  let spawnError: Error | null = null;
  const closed = new Promise<number | null>((resolveClose) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      reaped.reaped = true;
      reaped.code = code;
      resolveClose(code);
    });
  });
  const outputBudget = new OutputBudget();
  const stdoutCap = new OutputCap(outputBudget);
  const stderrCap = new OutputCap(outputBudget);
  child.stdout?.on("data", (chunk: Buffer) => stdoutCap.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrCap.push(chunk));

  const pid = child.pid ?? 0;
  const pidStartedAt = pid > 0 ? (processStartTimeMs(pid) ?? Date.now()) : null;
  if (pid > 0 && pidStartedAt !== null && onSpawned) {
    try {
      onSpawned({ pid, pidStartedAt });
    } catch (error) {
      await terminateAndReap(child, pid, reaped, closed);
      throw error;
    }
  }

  const outcome = (
    status: CellExecOutcome["status"],
    exitCode: number | null,
  ): CellExecOutcome => ({
    status,
    exitCode,
    stdout: stdoutCap.text(),
    stderr: stderrCap.text(),
    truncated: outputBudget.truncated,
    timeoutMs,
    pid: pid > 0 ? pid : null,
    pidStartedAt,
  });

  const timedOut = !(await closesWithin(closed, timeoutMs));
  if (timedOut) {
    await terminateAndReap(child, pid, reaped, closed);
    return outcome("timeout", reaped.code);
  }

  if (spawnError) throw spawnError;
  return outcome(reaped.code === 0 ? "ok" : "nonzero", reaped.code);
}
