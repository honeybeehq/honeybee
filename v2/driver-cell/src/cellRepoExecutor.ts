import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CELL_REPO_DIAGNOSTIC_BYTES, CELL_REPO_REPORT_BYTES, CellRepoRefusal, parseCellRepoInspection, type CellRepoIdentity, type CellRepoRequest } from "./cellRepoProtocol.ts";

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

export async function executeCellRepoBatch(data: { identity: CellRepoIdentity; request: CellRepoRequest; timeoutMs: number; helperPath?: string }, signal?: AbortSignal): Promise<import("./cellRepoProtocol.ts").CellRepoInspection> {
  if (signal?.aborted) throw new CellRepoRefusal("deadline");
  const before = await validate(data.identity);
  if (process.platform !== "linux") throw new CellRepoRefusal("unavailable");
  const helper = await realpath(data.helperPath ?? fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../dist/v2/cell-repo-helper.js" : "./cell-repo-helper.js", import.meta.url)));
  const node = await realpath(process.execPath);
  for (const path of [helper, node]) {
    const info = await lstat(path);
    const within = relative(data.identity.cellsRoot, path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))) throw new CellRepoRefusal("unavailable");
  }
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL", "--tmpfs", "/",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/scratch", "--dir", "/run", "--dir", "/run/hive",
    "--ro-bind", node, "/run/hive/node", "--ro-bind", helper, "/run/hive/helper.mjs",
    "--ro-bind", data.identity.spaceDir, "/cell", "--chdir", "/cell", "/run/hive/node", "/run/hive/helper.mjs"];
  if (signal?.aborted) throw new CellRepoRefusal("deadline");
  const result = await new Promise<string>((resolveResult, reject) => {
    const child = spawn("/usr/bin/bwrap", args, { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let bytes = 0;
    let diagnosticBytes = 0;
    let failure: CellRepoRefusal | null = null;
    const stop = (code: "deadline" | "output_limit") => { failure ??= new CellRepoRefusal(code); child.kill("SIGKILL"); };
    const abort = () => stop("deadline");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop("deadline"), data.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > CELL_REPO_REPORT_BYTES) stop("output_limit");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { diagnosticBytes += chunk.length; if (diagnosticBytes > CELL_REPO_DIAGNOSTIC_BYTES) stop("output_limit"); });
    child.once("error", () => { failure ??= new CellRepoRefusal("unavailable"); });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(data.request));
    child.once("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new CellRepoRefusal("git_failed"));
      else resolveResult(Buffer.concat(output).toString("utf8"));
    });
  });
  const after = await validate(data.identity);
  if (before.paths.some((item, index) => item.dev !== after.paths[index]?.dev || item.ino !== after.paths[index]?.ino)) throw new CellRepoRefusal("identity_changed");
  return parseCellRepoInspection(JSON.parse(result));
}

