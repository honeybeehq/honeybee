import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class CellCredentialRefusal extends Error {
  readonly code = "account_auth_needed";
  constructor() { super("auth_needed: sandboxed Codex requires access-only credentials; enroll native accounts through the human operator"); }
}

export function accessOnlyCodexDocument(raw: string): string {
  try {
    if (Buffer.byteLength(raw) > 65_536) throw new Error();
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error();
    if (Object.keys(doc).some(key => !["auth_mode", "tokens", "last_refresh", "OPENAI_API_KEY"].includes(key))) throw new Error();
    if (doc.OPENAI_API_KEY != null || doc.auth_mode !== undefined && doc.auth_mode !== "chatgpt") throw new Error();
    const tokens = doc.tokens;
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new Error();
    if (tokens.refresh_token !== "" || typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error();
    if (Object.keys(tokens).some(key => !["access_token", "id_token", "account_id", "refresh_token"].includes(key))) throw new Error();
    if (Object.values(tokens).some(value => typeof value !== "string")) throw new Error();
    if (doc.last_refresh !== undefined && typeof doc.last_refresh !== "string") throw new Error();
    return JSON.stringify(doc);
  } catch { throw new CellCredentialRefusal(); }
}

export function readAccessOnlyCodex(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 65_536) throw new Error();
    const bytes = Buffer.alloc(65_537);
    let count = 0;
    while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
    if (count > 65_536) throw new Error();
    const raw = bytes.subarray(0, count).toString("utf8");
    const after = fstatSync(fd);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error();
    return accessOnlyCodexDocument(raw);
  } catch { throw new CellCredentialRefusal(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function snapshotAccessOnlyCodex(sourceHome: string, source: string, snapshotRoot?: string): string {
  const raw = readAccessOnlyCodex(source);
  const root = snapshotRoot ?? join(sourceHome, ".honeybee-cell-access");
  try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CellCredentialRefusal(); }
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0) throw new CellCredentialRefusal();
  const target = join(root, `${createHash("sha256").update(raw).digest("hex")}.json`);
  if (!lstatSync(target, { throwIfNoEntry: false }) && readdirSync(root).length >= 128) throw new CellCredentialRefusal();
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    writeFileSync(fd, raw);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CellCredentialRefusal(); }
  finally { if (fd !== undefined) closeSync(fd); }
  const pinned = lstatSync(target);
  if (!pinned.isFile() || pinned.isSymbolicLink() || pinned.uid !== process.geteuid?.() || (pinned.mode & 0o222) !== 0 || readAccessOnlyCodex(target) !== raw) throw new CellCredentialRefusal();
  return target;
}
