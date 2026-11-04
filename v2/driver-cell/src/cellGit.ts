import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { devNull } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertHostGitVersion, refuseMissingGitObjects } from "../../../src/hostGitRuntime.ts";
import { gitEnv, hostGitEnv, type GitResult } from "./git.ts";

export interface CellGitIdentity {
  cellsRoot: string;
  wrapper: string;
  spaceDir: string;
  sandboxed: boolean;
  independentInodes: boolean;
  onWarning?: (message: string) => void;
}

export class CellGitRefused extends Error {
  readonly code = "cell_git_refused";
  constructor(detail: string) { super(`Cell Git refused: ${detail}`); this.name = "CellGitRefused"; }
}

type Snapshot = { path: string; dev: number; ino: number };
const CONFIG_LIMIT = 256 * 1024;
const TIMEOUT = 15000;
const ALLOWED = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|protecthfs|protectntfs|editor|pager|hookspath|fsmonitor)|user\.(?:name|email|signingkey)|remote\..+\.(?:url|pushurl|fetch|promisor|partialclonefilter)|branch\..+\.(?:remote|merge)|notes\.displayref|commit\.gpgsign|tag\.gpgsign|gpg\.format|filter\..+\.(?:clean|smudge|process|required)|extensions\.(?:objectformat|partialclone))$/i;

function directory(path: string): Snapshot {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new CellGitRefused("repository directory layout is unsupported");
  return { path, dev: info.dev, ino: info.ino };
}

function boundedFile(path: string, optional = false): string {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info && optional) return "";
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > CONFIG_LIMIT) throw new CellGitRefused("repository control file layout is unsupported");
  const content = readFileSync(path);
  if (content.length > CONFIG_LIMIT) throw new CellGitRefused("repository control file exceeds bound");
  return content.toString("utf8");
}

function gitDirectories(cell: CellGitIdentity): {git: string; common: string; objects: string} {
  let git = join(cell.spaceDir, ".git");
  const info = lstatSync(git);
  if (info.isFile() && !cell.sandboxed) {
    const pointer = /^gitdir: ([^\r\n]+)\n?$/.exec(boundedFile(git));
    if (!pointer) throw new CellGitRefused("worktree Git pointer is malformed");
    git = resolve(cell.spaceDir, pointer[1]!);
  }
  directory(git);
  let common = git;
  const commonText = boundedFile(join(git, "commondir"), true).trim();
  if (commonText) {
    if (cell.sandboxed || commonText.includes("\n")) throw new CellGitRefused("repository indirection is unsupported");
    common = resolve(git, commonText);
    directory(common);
  }
  return {git, common, objects:join(common,"objects")};
}

function layout(cell: CellGitIdentity): Snapshot[] {
  if (cell.sandboxed && cell.independentInodes !== true) throw new CellGitRefused("independent object storage has not been verified");
  if (![cell.cellsRoot, cell.spaceDir].every(isAbsolute) || !cell.wrapper || cell.wrapper === "." || cell.wrapper === ".." || cell.wrapper.includes(sep)) throw new CellGitRefused("trusted Cell identity is invalid");
  const wrapper = join(cell.cellsRoot, cell.wrapper);
  const suffix = relative(wrapper, cell.spaceDir);
  if (!suffix || suffix === ".." || suffix.includes(sep) || join(wrapper, suffix) !== cell.spaceDir) throw new CellGitRefused("checkout does not belong to its trusted wrapper");
  const {git, common, objects} = gitDirectories(cell);
  const snapshots = [...new Set([cell.cellsRoot, wrapper, cell.spaceDir, git, common, objects])].map(directory);
  const infoPath = join(objects, "info");
  if (lstatSync(infoPath, { throwIfNoEntry: false })) snapshots.push(directory(infoPath));
  if (cell.sandboxed) for (const file of [join(objects, "info", "alternates"), join(objects, "info", "http-alternates"), join(git, "config.worktree")]) {
    if (boundedFile(file, true).trim() !== "") throw new CellGitRefused("repository indirection is unsupported");
  }
  return snapshots;
}

function environment(cell: CellGitIdentity): Record<string, string> {
  const env = gitEnv();
  const dirs = gitDirectories(cell);
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0",
    GIT_DIR: dirs.git, GIT_COMMON_DIR: dirs.common, GIT_WORK_TREE: cell.spaceDir,
    GIT_OBJECT_DIRECTORY: dirs.objects, GIT_CEILING_DIRECTORIES: cell.cellsRoot,
    GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_PAGER: "cat", PAGER: "cat", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "hive-cell", GIT_AUTHOR_EMAIL: "cell@hive.invalid", GIT_COMMITTER_NAME: "hive-cell", GIT_COMMITTER_EMAIL: "cell@hive.invalid",
  });
  return hostGitEnv(env, [["core.worktree", cell.spaceDir], ["core.bare", "false"], ["core.sharedRepository", "false"], ["safe.bareRepository", "explicit"], ["gc.auto", "0"]]);
}

function invoke(cell: CellGitIdentity, args: string[], env: Record<string, string>, input?: string, timeout = TIMEOUT): GitResult {
  const result = spawnSync("git", args, { cwd: cell.spaceDir, env, input, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.signal) throw new CellGitRefused("repository command failed or exceeded its bound");
  refuseMissingGitObjects(result.status, result.stderr ?? "");
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function validateConfig(cell: CellGitIdentity, env: Record<string, string>): Array<readonly [string, string]> {
  const config = join(gitDirectories(cell).common, "config");
  boundedFile(config);
  const result = invoke(cell, ["config", "--file", config, "--no-includes", "--null", "--list"], env);
  if (result.status !== 0 || result.stdout.length > CONFIG_LIMIT) throw new CellGitRefused("repository configuration cannot be validated");
  const records = result.stdout.split("\0");
  if (records.pop() !== "") throw new CellGitRefused("repository configuration is malformed");
  const overrides: Array<readonly [string, string]> = [];
  for (const record of records) {
    const split = record.indexOf("\n"), key = split < 0 ? record : record.slice(0, split), value = split < 0 ? "" : record.slice(split + 1);
    if (/^filter\..+\.(?:clean|smudge|process|required)$/i.test(key)) overrides.push([key, /\.required$/i.test(key) ? "false" : ""]);
    const unknown = !ALLOWED.test(key) || cell.sandboxed && /^remote\..+\.(?:promisor|partialclonefilter)$/i.test(key);
    if (unknown) {
      if (cell.sandboxed) throw new CellGitRefused("repository configuration contains an unsupported setting");
      const message = "Cell Git: unconfined repository has an unsupported configuration setting; proceeding under pinned environment";
      if (cell.onWarning) cell.onWarning(message); else process.emitWarning(message, {code:"cell_git_config_warning"});
    }
    if (/^core\.bare$/i.test(key) && !/^(?:false|no|off|0)$/i.test(value)) throw new CellGitRefused("bare checkout configuration is unsupported");
    if (/^core\.repositoryformatversion$/i.test(key) && !/^[01]$/.test(value)) throw new CellGitRefused("repository format is unsupported");
    if (/^extensions\.objectformat$/i.test(key) && !/^(?:sha1|sha256)$/.test(value)) throw new CellGitRefused("object format is unsupported");
  }
  return overrides;
}

export function withCellGit<T>(cell: CellGitIdentity, operation: (run: (args: string[], opts?: {input?: string; timeoutMs?: number}) => GitResult) => T): T {
  const before = layout(cell), baseEnv = environment(cell);
  assertHostGitVersion(cell.spaceDir, baseEnv);
  const env = hostGitEnv(baseEnv, validateConfig(cell, baseEnv));
  try {
    return operation((args, opts = {}) => {
      if (args.length === 0 || args[0]!.startsWith("-") || args.some(arg => /^(?:--git-dir|--work-tree|--config-env|--exec-path)(?:=|$)/.test(arg)) || args.includes("-C") || args.includes("-c")) throw new CellGitRefused("repository command attempts to override trusted context");
      const timeout = opts.timeoutMs ?? TIMEOUT;
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > TIMEOUT) throw new CellGitRefused("repository command timeout is invalid");
      const safeArgs = [...args];
      if (["status", "diff"].includes(args[0]!)) safeArgs.splice(1, 0, "--ignore-submodules=all");
      layout(cell);
      const currentEnv = hostGitEnv(baseEnv, validateConfig(cell, baseEnv));
      return invoke(cell, safeArgs, currentEnv, opts.input, timeout);
    });
  } finally {
    const after = layout(cell);
    if (before.length !== after.length || before.some((entry, index) => entry.dev !== after[index]!.dev || entry.ino !== after[index]!.ino)) throw new CellGitRefused("repository directories changed during the operation");
    validateConfig(cell, env);
  }
}

export function cellGit(cell: CellGitIdentity, args: string[], opts: {input?: string; timeoutMs?: number} = {}): GitResult {
  return withCellGit(cell, run => run(args, opts));
}
