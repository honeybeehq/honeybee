import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class CellCredentialRefusal extends Error {
  readonly code = "account_auth_needed";
  constructor(snapshotName?: string) { super("auth_needed: sandboxed Codex requires access-only credentials; enroll native accounts through the human operator" + (snapshotName ? `; invalid snapshot metadata: ${snapshotName}` : "")); }
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

export function snapshotAccessOnlyCodex(sourceHome: string, source: string, snapshotRoot?: string, liveDigests: readonly string[] = []): string {
  const raw = readAccessOnlyCodex(source);
  const root = snapshotRoot ?? join(sourceHome, ".honeybee-cell-access");
  try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CellCredentialRefusal(); }
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0) throw new CellCredentialRefusal();
  const target = join(root, `${createHash("sha256").update(raw).digest("hex")}.json`);
  const retained = new Set([...liveDigests, createHash("sha256").update(raw).digest("hex")]);
  for (const name of readdirSync(root).filter(name => /^\.stage-[a-f0-9-]{36}$/.test(name))) {
    const staged=lstatSync(join(root,name));
    if (staged.isFile() && !staged.isSymbolicLink() && staged.uid === process.geteuid?.() && (staged.mode & 0o222) === 0 && staged.mtimeMs < Date.now()-10*60_000) unlinkSync(join(root,name));
  }
  const snapshots = readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => ({name, info:lstatSync(join(root,name))}));
  snapshots.sort((a,b) => b.info.mtimeMs-a.info.mtimeMs || a.name.localeCompare(b.name));
  for (const snapshot of snapshots.slice(8)) {
    if (retained.has(snapshot.name.slice(0,-5))) continue;
    if (!snapshot.info.isFile() || snapshot.info.isSymbolicLink() || snapshot.info.uid !== process.geteuid?.() || (snapshot.info.mode & 0o222) !== 0) throw new CellCredentialRefusal(snapshot.name);
    unlinkSync(join(root,snapshot.name));
  }
  const existing = lstatSync(target, {throwIfNoEntry:false});
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== process.geteuid?.() || (existing.mode & 0o222) !== 0)) throw new CellCredentialRefusal();
  let valid = false;
  if (existing) { try { valid = readAccessOnlyCodex(target) === raw; } catch {} }
  if (!valid) {
    const temporary = join(root, `.stage-${randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
      writeFileSync(fd, raw); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary,target);
      fd = openSync(root,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fsyncSync(fd);
    } catch { throw new CellCredentialRefusal(); }
    finally { if (fd !== undefined) closeSync(fd); if (lstatSync(temporary,{throwIfNoEntry:false})) unlinkSync(temporary); }
  }
  const pinned = lstatSync(target);
  if (!pinned.isFile() || pinned.isSymbolicLink() || pinned.uid !== process.geteuid?.() || (pinned.mode & 0o222) !== 0 || readAccessOnlyCodex(target) !== raw) throw new CellCredentialRefusal();
  return target;
}
