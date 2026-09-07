/**
 * Claude cwd-keyed transcript carry for Cell→checkout move.
 * Filesystem only — caller commits SQLite placement after this returns.
 *
 * After exact source exit: copy `projects/<fromKey>/<sid>.jsonl` (+ sibling
 * dir) into the dest project key. Staging dir is owned by this moveId.
 * Unrelated dest files are refused. Partial staging is retried, never treated
 * as a successful resume. Source is never modified. Dest is never overwritten.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
  constants,
  linkSync,
} from "node:fs";
import { join } from "node:path";
import { claudeProjectKey } from "../../driver-tmux/src/index.ts";

export class TranscriptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptConflictError";
  }
}

export class TranscriptUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptUnavailableError";
  }
}

export type RelocateResult = "copied" | "present" | "none";

/** Authoritative source path only — no scan of other project keys. */
export function findClaudeTranscript(
  home: string,
  projectKey: string,
  seed: string,
): { file: string; dir: string | null } | null {
  const file = join(home, "projects", projectKey, `${seed}.jsonl`);
  if (!existsSync(file)) return null;
  const sibling = join(home, "projects", projectKey, seed);
  return { file, dir: existsSync(sibling) ? sibling : null };
}

function filesEqual(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false;
  return readFileSync(a).equals(readFileSync(b));
}

/** Exclusive create: link, else O_EXCL write. Never a replacing rename. */
function exclusivePublishFile(src: string, dest: string): void {
  try {
    linkSync(src, dest);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw err;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") throw err;
  }
  const fd = openSync(dest, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  try {
    writeFileSync(fd, readFileSync(src));
  } finally {
    closeSync(fd);
  }
}

export function relocateClaudeSession(opts: {
  home: string;
  sessionId: string;
  fromCwd: string;
  toCwd: string;
  moveId: string;
}): RelocateResult {
  const seed = opts.sessionId;
  const fromKey = claudeProjectKey(opts.fromCwd);
  const toKey = claudeProjectKey(opts.toCwd);
  const destDir = join(opts.home, "projects", toKey);
  const destFile = join(destDir, `${seed}.jsonl`);
  const destSibling = join(destDir, seed);
  const marker = join(destDir, `.hive-move-${opts.moveId}`);
  const staging = join(destDir, `.hive-move-staging-${opts.moveId}`);
  const stagedJsonl = join(staging, `${seed}.jsonl`);
  const stagedSibling = join(staging, seed);

  const ours =
    existsSync(marker) ||
    (existsSync(staging) && existsSync(stagedJsonl) && existsSync(destFile) && filesEqual(destFile, stagedJsonl));

  if (existsSync(destFile) && !ours) {
    throw new TranscriptConflictError(
      `destination already has conversation ${seed} under ${destDir} that this move did not write`,
    );
  }
  if (existsSync(destSibling) && !ours && !existsSync(marker)) {
    throw new TranscriptConflictError(
      `destination sibling ${destSibling} exists and is not owned by this move`,
    );
  }

  if (ours) {
    finishPublication({ destSibling, marker, staging, stagedSibling, moveId: opts.moveId });
    return "present";
  }

  const source = findClaudeTranscript(opts.home, fromKey, seed);
  if (!source) {
    throw new TranscriptUnavailableError(
      `conversation ${seed} was not found under ${opts.home} (projects/${fromKey})`,
    );
  }

  if (!existsSync(stagedJsonl)) {
    mkdirSync(staging, { recursive: true });
    copyFileSync(source.file, stagedJsonl);
    if (source.dir) cpSync(source.dir, stagedSibling, { recursive: true });
  }

  mkdirSync(destDir, { recursive: true });
  try {
    exclusivePublishFile(stagedJsonl, destFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      if (existsSync(marker) || filesEqual(destFile, stagedJsonl)) {
        finishPublication({ destSibling, marker, staging, stagedSibling, moveId: opts.moveId });
        return "present";
      }
      throw new TranscriptConflictError(
        `destination already has conversation ${seed} under ${destDir} that this move did not write`,
      );
    }
    throw err;
  }

  finishPublication({ destSibling, marker, staging, stagedSibling, moveId: opts.moveId });
  return "copied";
}

function finishPublication(opts: {
  destSibling: string;
  marker: string;
  staging: string;
  stagedSibling: string;
  moveId: string;
}): void {
  if (existsSync(opts.stagedSibling) && !existsSync(opts.destSibling)) {
    renameSync(opts.stagedSibling, opts.destSibling);
  }
  if (!existsSync(opts.marker)) writeFileSync(opts.marker, `${opts.moveId}\n`);
  rmSync(opts.staging, { recursive: true, force: true });
}
