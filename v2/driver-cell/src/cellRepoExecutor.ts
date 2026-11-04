import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProcess, sameProcess, type ProcessIdentity } from "../../harness/src/processIdentity.ts";
import { validatedCellScopeBinary } from "./cellScope.ts";
import { CELL_REPO_DIAGNOSTIC_BYTES, CELL_REPO_STATUS_BYTES, cellRepoFailure, CELL_REPO_REPORT_BYTES, CellRepoRefusal, parseCellRepoInspection, type CellRepoIdentity, type CellRepoRequest } from "./cellRepoProtocol.ts";

interface IdentityStamp { paths: Array<{ path: string; dev: number; ino: number }> }

async function validate(identity: CellRepoIdentity): Promise<IdentityStamp> {
  const { cellsRoot, wrapper, spaceDir } = identity;
  if (!identity.sandboxed || !identity.independentInodes || !isAbsolute(cellsRoot) || !isAbsolute(spaceDir)
    || wrapper.length === 0 || wrapper === "." || wrapper === ".." || wrapper.includes(sep)
    || resolve(cellsRoot) !== cellsRoot || resolve(spaceDir) !== spaceDir
    || dirname(spaceDir) !== join(cellsRoot, wrapper) || await realpath(cellsRoot) !== cellsRoot) throw new CellRepoRefusal("invalid_repository");
  const paths: IdentityStamp["paths"] = [];
  for (const path of [join(cellsRoot, wrapper), spaceDir, join(spaceDir, ".git"), join(spaceDir, ".git", "objects")]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new CellRepoRefusal("invalid_repository");
    paths.push({ path, dev: info.dev, ino: info.ino });
  }
  for (const path of ["objects/info", "objects/pack"]) {
    const info = await lstat(join(spaceDir, ".git", path)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new CellRepoRefusal("invalid_repository");
  }
  for (const path of ["commondir", "objects/info/alternates", "objects/info/http-alternates"]) {
    if (await lstat(join(spaceDir, ".git", path)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new CellRepoRefusal("invalid_repository");
  }
  return { paths };
}

export async function executeCellRepoBatch(data: { identity: CellRepoIdentity; request: CellRepoRequest; timeoutMs: number; helperPath?: string }, signal?: AbortSignal, onStarted?: (identity: ProcessIdentity) => void, afterPin?: () => Promise<() => Promise<void>>): Promise<import("./cellRepoProtocol.ts").CellRepoInspection> {
  if (signal?.aborted) throw new CellRepoRefusal("deadline");
  const before = await validate(data.identity);
  if (process.platform !== "linux") throw new CellRepoRefusal("unavailable");
  const directory = await open(data.identity.spaceDir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  let restore: (() => Promise<void>) | undefined;
  try {
  const pinned = await directory.stat();
  if (pinned.dev !== before.paths[1]?.dev || pinned.ino !== before.paths[1]?.ino) throw new CellRepoRefusal("identity_changed");
  restore = await afterPin?.();
  const helper = await realpath(data.helperPath ?? fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../dist/v2/cell-repo-helper.js" : "./cell-repo-helper.js", import.meta.url)));
  const node = await realpath(process.execPath);
  for (const path of [helper, node]) {
    const info = await lstat(path);
    const within = relative(data.identity.cellsRoot, path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))) throw new CellRepoRefusal("unavailable");
  }
  const manifest = JSON.parse(await readFile(join(dirname(helper), "cell-repo-manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.files?.[basename(helper)] !== createHash("sha256").update(await readFile(helper)).digest("hex")) throw new CellRepoRefusal("unavailable");
  const scope = validatedCellScopeBinary();
  const parentNamespace = await stat("/proc/self/ns/user");
  const args = ["--", "/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--clearenv", "--cap-drop", "ALL", "--tmpfs", "/",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/scratch", "--dir", "/run", "--dir", "/run/hive",
    "--ro-bind", node, "/run/hive/node", "--ro-bind", helper, "/run/hive/helper.mjs", "--ro-bind", scope, "/run/hive/scope",
    "--ro-bind-fd", "3", "/cell", "--chdir", "/cell", "/run/hive/scope", "--assert-userns", `${parentNamespace.dev}:${parentNamespace.ino}`, "--", "/run/hive/node", "/run/hive/helper.mjs", String(data.timeoutMs)];
  if (signal?.aborted) throw new CellRepoRefusal("deadline");
  const result = await new Promise<string>((resolveResult, reject) => {
    const child = spawn(scope, args, { env: {}, stdio: ["pipe", "pipe", "pipe", directory.fd] });
    const observed = child.pid === undefined ? null : inspectProcess(child.pid);
    const identity = observed?.kind === "present" ? { pid: observed.pid, birth: observed.birth, bootId: observed.bootId } : null;
    if (identity) onStarted?.(identity);
    const output: Buffer[] = [];
    let bytes = 0;
    let diagnosticBytes = 0;
    let failure: CellRepoRefusal | null = null;
    const stop = (code: "deadline" | "output_limit" | "unavailable") => {
      failure ??= new CellRepoRefusal(code);
      const current = identity ? inspectProcess(identity.pid) : null;
      if (identity && current && sameProcess(identity, current)) {
        try { process.kill(identity.pid, "SIGKILL"); } catch {}
      } else child.kill("SIGKILL");
    };
    if (!identity) stop("unavailable");
    const abort = () => stop("deadline");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop("deadline"), data.timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > CELL_REPO_REPORT_BYTES) stop("output_limit");
      else output.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => { diagnosticBytes += chunk.length; if (diagnosticBytes > CELL_REPO_DIAGNOSTIC_BYTES) stop("output_limit"); });
    child.once("error", () => { failure ??= new CellRepoRefusal("unavailable"); });
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify(data.request));
    child.once("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new CellRepoRefusal("git_failed"));
      else resolveResult(Buffer.concat(output).toString("utf8"));
    });
  });
  await restore?.();
  restore = undefined;
  const after = await validate(data.identity);
  if (before.paths.some((item, index) => item.dev !== after.paths[index]?.dev || item.ino !== after.paths[index]?.ino)) throw new CellRepoRefusal("identity_changed");
  const wire = JSON.parse(result) as Record<string, unknown>;
  if (wire && Object.keys(wire).length === 1 && cellRepoFailure(wire.failure)) throw new CellRepoRefusal(cellRepoFailure(wire.failure)!);
  if (!wire || Object.keys(wire).length !== 4 || typeof wire.statusBase64 !== "string") throw new CellRepoRefusal("invalid_output");
  const status = Buffer.from(wire.statusBase64, "base64");
  if (status.length > CELL_REPO_STATUS_BYTES || status.toString("base64") !== wire.statusBase64 || !isUtf8(status)) throw new CellRepoRefusal("invalid_output");
  return parseCellRepoInspection({ head: wire.head, status: status.toString("utf8"), branches: wire.branches, stashed: wire.stashed });
  } finally { try { await restore?.(); } finally { await directory.close(); } }
}
