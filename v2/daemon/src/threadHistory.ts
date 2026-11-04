/** Bounded admission, streaming copies, and paged access to native append-only history. */
import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { open, rename, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ThreadOperationRow } from "../../core/src/threadOperation.ts";

export class ThreadExecutionError extends Error {
  readonly code: import("../../core/src/threadOperation.ts").ThreadFailureCode;
  constructor(code: import("../../core/src/threadOperation.ts").ThreadFailureCode, message: string) { super(message); this.code = code; }
}
const HEADER_LIMIT = 1024 * 1024;

export interface HistoryRoot { readonly path: string; readonly dev: number; readonly ino: number; }

function historyRoot(path: string): HistoryRoot {
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ThreadExecutionError("history_unavailable", "History root is not a regular directory");
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}

function checkOwnedHistory(stat: Stats, path: string, root: HistoryRoot, minimumBytes: number): string {
  const currentRoot = lstatSync(root.path);
  const target = realpathSync(path);
  const current = statSync(target);
  if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino || !stat.isFile() || stat.size < minimumBytes || !target.startsWith(`${root.path}/`) || stat.dev !== current.dev || stat.ino !== current.ino) throw new ThreadExecutionError("history_unavailable", "History ownership changed or is not an owned regular file");
  return target;
}

async function openOwnedHistory(path: string, minimumBytes: number, expectedRoot?: string) {
  const root = historyRoot(expectedRoot ?? dirname(path));
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { checkOwnedHistory(await fd.stat(), path, root, minimumBytes); return fd; }
  catch (error) { await fd.close(); throw error; }
}

/** The provider's indexed path lookup is O(1); never scan all account histories on RPC admission. */
export function codexHistoryPath(home: string, sessionId: string): { path: string; root: HistoryRoot } {
  const path = join(home, "state_5.sqlite");
  if (!existsSync(path)) throw new ThreadExecutionError("history_unavailable", "Codex's indexed rollout path is unavailable; resume the source on this node first");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(sessionId);
    if (typeof row?.rollout_path !== "string") throw new ThreadExecutionError("history_unavailable", "Source has no indexed native rollout");
    try {
      const namedRoot = resolve(home, "sessions");
      const root = join(realpathSync(home), "sessions");
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !isAbsolute(row.rollout_path)) throw new Error("unsafe sessions root");
      const requested = resolve(row.rollout_path);
      const namedRelative = relative(namedRoot, requested);
      const tail = namedRelative !== ".." && !namedRelative.startsWith(`..${sep}`) && !isAbsolute(namedRelative) ? namedRelative : relative(root, requested);
      if (!tail || tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error("outside sessions root");
      let cursor = root;
      for (const component of tail.split(sep)) {
        cursor = join(cursor, component);
        if (lstatSync(cursor).isSymbolicLink()) throw new Error("symlink rollout path");
      }
      if (!lstatSync(cursor).isFile()) throw new Error("rollout is not a regular file");
      return { path: cursor, root: { path: root, dev: rootStat.dev, ino: rootStat.ino } };
    } catch { throw new ThreadExecutionError("history_unavailable", "Source rollout must be a regular file beneath its sessions root without symlinks"); }
  } finally { db.close(); }
}

export function pinThreadHistory(path: string, sessionId: string, expectedRoot?: HistoryRoot): ThreadOperationRow["source"] {
  const root = expectedRoot ?? historyRoot(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) throw new ThreadExecutionError("history_unavailable", "Source rollout is empty or not a file");
    const target = checkOwnedHistory(stat, path, root, 1);
    const header = Buffer.alloc(Math.min(stat.size, HEADER_LIMIT));
    const n = readSync(fd, header, 0, header.length, 0);
    const end = header.subarray(0, n).indexOf(10);
    if (end < 0) throw new ThreadExecutionError("history_unavailable", "Source rollout header exceeds 1 MiB");
    const meta = JSON.parse(header.subarray(0, end).toString("utf8"));
    if (meta.type !== "session_meta" || meta.payload?.id !== sessionId) throw new ThreadExecutionError("history_changed", "Source rollout identity does not match the bee");
    if (typeof meta.payload.model_provider !== "string" || !meta.payload.model_provider) throw new ThreadExecutionError("history_unavailable", "Source model provider is not recorded");
    const tail = Buffer.alloc(Math.min(stat.size, HEADER_LIMIT));
    const start = stat.size - tail.length;
    const count = readSync(fd, tail, 0, tail.length, start);
    const lastNewline = tail.subarray(0, count).lastIndexOf(10);
    if (lastNewline < 0) throw new ThreadExecutionError("history_unavailable", "Source has an unfinished record larger than 1 MiB");
    return { path: target, bytes: start + lastNewline + 1, dev: stat.dev, ino: stat.ino, modelProvider: meta.payload.model_provider };
  } finally { closeSync(fd); }
}

async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, "r");
  try { await fd.sync(); } finally { await fd.close(); }
}

/** Neither RAM usage nor admission latency scales with conversation length. */
export async function copyPinnedHistory(row: ThreadOperationRow): Promise<void> {
  await mkdir(dirname(row.historyPath), { recursive: true });
  // A crash after atomic rename but before the SQLite readiness receipt must
  // recover the already-owned snapshot, even if the source was later deleted.
  if (existsSync(row.historyPath)) {
    const existing = pinThreadHistory(row.historyPath, row.sourceProviderSessionId);
    if (existing.bytes !== row.source.bytes) throw new ThreadExecutionError("history_changed", "Owned snapshot length changed");
    return;
  }
  const input = await openOwnedHistory(row.source.path, 0);
  const temp = `${row.historyPath}.partial`;
  const output = await open(temp, "w", 0o600);
  try {
    const stat = await input.stat();
    if (stat.dev !== row.source.dev || stat.ino !== row.source.ino || stat.size < row.source.bytes) {
      throw new ThreadExecutionError("history_changed", "Pinned source file was replaced or truncated");
    }
    const buffer = Buffer.alloc(256 * 1024);
    let offset = 0;
    while (offset < row.source.bytes) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, row.source.bytes - offset), offset);
      if (bytesRead === 0) throw new ThreadExecutionError("history_changed", "Pinned history ended early");
      await output.writeFile(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await output.sync();
  } finally { await input.close(); await output.close(); }
  await rename(temp, row.historyPath);
  await syncDirectory(dirname(row.historyPath));
}

/** A deterministic native fork identity. Only the session header changes; all conversation items are copied. */
export async function seedSuccessorHistory(row: ThreadOperationRow): Promise<void> {
  const input = await openOwnedHistory(row.historyPath, row.source.bytes);
  const output = await open(`${row.sessionPath}.partial`, "w", 0o600);
  try {
    const header = Buffer.alloc(HEADER_LIMIT);
    const { bytesRead } = await input.read(header, 0, header.length, 0);
    const end = header.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw new ThreadExecutionError("history_unavailable", "Missing native session header");
    const meta = JSON.parse(header.subarray(0, end).toString("utf8"));
    if (meta.type !== "session_meta" || meta.payload?.id !== row.sourceProviderSessionId) throw new ThreadExecutionError("history_changed", "Pinned history identity mismatch");
    meta.payload.id = row.successorProviderSessionId;
    meta.payload.forked_from_id = row.sourceProviderSessionId;
    await output.writeFile(JSON.stringify(meta) + "\n");
    let offset = end + 1;
    while (offset < row.source.bytes) {
      const chunk = await input.read(header, 0, Math.min(header.length, row.source.bytes - offset), offset);
      if (!chunk.bytesRead) throw new ThreadExecutionError("history_changed", "Pinned history ended early");
      await output.writeFile(header.subarray(0, chunk.bytesRead));
      offset += chunk.bytesRead;
    }
    await output.sync();
  } finally { await input.close(); await output.close(); }
  await rename(`${row.sessionPath}.partial`, row.sessionPath);
  await syncDirectory(dirname(row.sessionPath));
}

export async function sourceBaseInstructions(row: ThreadOperationRow): Promise<string> {
  const fd = await openOwnedHistory(row.historyPath, row.source.bytes);
  try {
    const buffer = Buffer.alloc(HEADER_LIMIT);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    const meta = JSON.parse(buffer.subarray(0, end).toString("utf8"));
    const base = meta.payload?.base_instructions;
    if (typeof base?.text !== "string") throw new ThreadExecutionError("compaction_unsupported", "Native rollout has no reproducible base instructions");
    return base.text;
  } finally { await fd.close(); }
}

export async function readThreadHistory(row: ThreadOperationRow, offset: number, limit: number, historyRoot?: string): Promise<{ format: "codex.rollout.jsonl"; encoding: "base64"; data: string; nextOffset: number; eof: boolean }> {
  if (!row.transcriptReady) throw new ThreadExecutionError("history_unavailable", "Inherited transcript is not ready");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.source.bytes || !Number.isSafeInteger(limit) || limit < 1 || limit > 1048576) throw new ThreadExecutionError("history_unavailable", "Invalid transcript byte window");
  const fd = await openOwnedHistory(row.historyPath, row.source.bytes, historyRoot);
  try {
    const buffer = Buffer.alloc(Math.min(limit, Math.max(0, row.source.bytes - offset)));
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, offset);
    return { format: "codex.rollout.jsonl", encoding: "base64", data: buffer.subarray(0, bytesRead).toString("base64"), nextOffset: offset + bytesRead, eof: offset + bytesRead >= row.source.bytes };
  } finally { await fd.close(); }
}
