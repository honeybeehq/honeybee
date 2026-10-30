import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import * as zlib from "node:zlib";
import { claudeProjectKey } from "../../driver-tmux/src/transcripts.ts";
import { codexHistoryPath } from "./threadHistory.ts";

export const RESUME_BUNDLE_OBJECT_DIR = join("blobs", "resume-bundles");
const MAGIC = Buffer.from("hbrb1");
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const REF = /^[a-f0-9]{64}$/;

export interface ResumeState {
  root: string;
  paths: string[];
  stateKey: string | null;
}

export function resumeStateKey(harness: string, cwd: string): string | null {
  switch (harness) {
    case "claude":
      return claudeProjectKey(cwd);
    case "stub":
      return claudeProjectKey(cwd);
    default:
      return null;
  }
}

export function resumeStatePaths(harness: string, accountHome: string | null, cwd: string, providerSessionId: string): ResumeState | null {
  switch (harness) {
    case "claude": {
      const root = accountHome ?? join(process.env.HOME ?? "", ".claude");
      const key = claudeProjectKey(cwd);
      const file = join("projects", key, `${providerSessionId}.jsonl`);
      if (!existsSync(join(root, file))) return null;
      const dir = join("projects", key, providerSessionId);
      return { root, paths: existsSync(join(root, dir)) ? [file, dir] : [file], stateKey: key };
    }
    case "codex": {
      const root = accountHome ?? join(process.env.HOME ?? "", ".codex");
      let absolute: string;
      try {
        absolute = codexHistoryPath(root, providerSessionId);
      } catch {
        return null;
      }
      if (!existsSync(absolute)) return null;
      const rel = relative(root, absolute);
      if (rel.startsWith("..")) return null;
      return { root, paths: [rel], stateKey: null };
    }
    case "stub": {
      const root = accountHome ?? cwd;
      const file = join("projects", claudeProjectKey(cwd), `${providerSessionId}.json`);
      if (!existsSync(join(root, file))) return null;
      return { root, paths: [file], stateKey: claudeProjectKey(cwd) };
    }
    default:
      return null;
  }
}

export function resumeStateScope(harness: string, accountHome: string | null): string | null {
  if (!accountHome) return null;
  try {
    if (harness === "claude" || harness === "stub") {
      const raw = JSON.parse(readFileSync(join(accountHome, ".claude.json"), "utf8")) as { oauthAccount?: { accountUuid?: unknown; organizationUuid?: unknown } };
      const org = raw.oauthAccount?.organizationUuid;
      const account = raw.oauthAccount?.accountUuid;
      if (typeof org === "string" && org.length > 0) return `org:${org}`;
      if (typeof account === "string" && account.length > 0) return `account:${account}`;
      return null;
    }
    if (harness === "codex") {
      const raw = JSON.parse(readFileSync(join(accountHome, "auth.json"), "utf8")) as { tokens?: { account_id?: unknown }; account_id?: unknown };
      const id = raw.tokens?.account_id ?? raw.account_id;
      return typeof id === "string" && id.length > 0 ? `account:${id}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function readResumeKey(keyFile: string): Buffer {
  const raw = readFileSync(keyFile);
  const text = raw.toString("utf8").trim();
  const key = /^[a-f0-9]{64}$/i.test(text) ? Buffer.from(text, "hex") : raw;
  if (key.length !== 32) throw new Error(`resume bundle key ${keyFile} must be 32 bytes (raw or 64 hex chars), got ${key.length}`);
  return key;
}

export function writeResumeKey(keyFile: string): void {
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
}

function bundleKey(workspaceKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", workspaceKey, salt, "honeybee-resume-bundle-v1", 32));
}

function zstd(): { compress: () => zlib.ZstdCompress; decompress: () => zlib.ZstdDecompress } {
  const compress = (zlib as Partial<typeof zlib>).createZstdCompress;
  const decompress = (zlib as Partial<typeof zlib>).createZstdDecompress;
  if (!compress || !decompress) throw new Error(`resume bundles need zstd in node:zlib (Node 22.15 or newer); this is ${process.version}`);
  return { compress: () => compress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }), decompress: () => decompress() };
}

export function resumeBundlePath(root: string, ref: string): string {
  if (!REF.test(ref)) throw new Error(`invalid resume bundle reference ${ref}`);
  return join(root, RESUME_BUNDLE_OBJECT_DIR, ref);
}

export interface ResumeBundleOutcome {
  ref: string;
  digest: string;
  bytes: number;
  size: number;
  files: number;
}

export async function bundleResumeState(state: ResumeState, storeRoot: string, workspaceKey: Buffer, beeId: string): Promise<ResumeBundleOutcome> {
  const dir = join(storeRoot, RESUME_BUNDLE_OBJECT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.partial`);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("chacha20-poly1305", bundleKey(workspaceKey, salt), nonce, { authTagLength: TAG_BYTES });
  (cipher as unknown as { setAAD(buffer: Buffer): void }).setAAD(Buffer.from(beeId, "utf8"));
  const tar = spawn("tar", ["-cf", "-", "--no-xattrs", "-C", state.root, ...state.paths], { stdio: ["ignore", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  tar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let size = 0;
  let files = 0;
  const plain = createHash("sha256");
  tar.stdout.on("data", (chunk: Buffer) => { size += chunk.length; plain.update(chunk); });
  for (const path of state.paths) {
    const info = statSync(join(state.root, path));
    files += info.isDirectory() ? 0 : 1;
  }
  const hash = createHash("sha256");
  const out = createWriteStream(temporary, { mode: 0o600 });
  const header = Buffer.concat([MAGIC, salt, nonce]);
  hash.update(header);
  out.write(header);
  let bytes = header.length;
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  const exit = new Promise<number | null>((resolve) => tar.once("close", (code) => resolve(code)));
  try {
    await pipeline(tar.stdout, zstd().compress(), cipher, counting, out);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
  const code = await exit;
  if (code !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(`tar exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
  }
  const tag = cipher.getAuthTag();
  const fd = openSync(temporary, "a");
  try {
    writeFileSync(fd, tag);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  hash.update(tag);
  bytes += tag.length;
  const ref = hash.digest("hex");
  const target = resumeBundlePath(storeRoot, ref);
  if (existsSync(target)) rmSync(temporary, { force: true });
  else renameSync(temporary, target);
  return { ref, digest: plain.digest("hex"), bytes, size, files };
}

export async function restoreResumeState(storeRoot: string, ref: string, workspaceKey: Buffer, beeId: string, destinationRoot: string): Promise<void> {
  const object = resumeBundlePath(storeRoot, ref);
  if (!existsSync(object)) throw new Error(`resume bundle ${ref} is missing from ${storeRoot}`);
  const total = statSync(object).size;
  const headerLength = MAGIC.length + SALT_BYTES + NONCE_BYTES;
  if (total < headerLength + TAG_BYTES) throw new Error(`resume bundle ${ref} is truncated`);
  const fd = openSync(object, "r");
  const header = Buffer.alloc(headerLength);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    readSync(fd, header, 0, headerLength, 0);
    readSync(fd, tag, 0, TAG_BYTES, total - TAG_BYTES);
  } finally {
    closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`resume bundle ${ref} has an unknown format`);
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const nonce = header.subarray(MAGIC.length + SALT_BYTES);
  const decipher = createDecipheriv("chacha20-poly1305", bundleKey(workspaceKey, salt), nonce, { authTagLength: TAG_BYTES });
  (decipher as unknown as { setAAD(buffer: Buffer): void }).setAAD(Buffer.from(beeId, "utf8"));
  decipher.setAuthTag(tag);
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const tar = spawn("tar", ["-xf", "-", "-C", destinationRoot], { stdio: ["pipe", "ignore", "pipe"] });
  const stderr: Buffer[] = [];
  tar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = new Promise<number | null>((resolve) => tar.once("close", (code) => resolve(code)));
  await pipeline(createReadStream(object, { start: headerLength, end: total - TAG_BYTES - 1 }), decipher, zstd().decompress(), tar.stdin);
  const code = await exit;
  if (code !== 0) throw new Error(`tar exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
}

export function rekeyRestoredState(harness: string, destinationRoot: string, fromKey: string | null, toKey: string | null): void {
  if (!fromKey || !toKey || fromKey === toKey) return;
  if (harness !== "claude" && harness !== "stub") return;
  const from = join(destinationRoot, "projects", fromKey);
  const to = join(destinationRoot, "projects", toKey);
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  if (!existsSync(to)) {
    renameSync(from, to);
    return;
  }
  for (const entry of readdirSync(from)) {
    const target = join(to, entry);
    if (!existsSync(target)) renameSync(join(from, entry), target);
  }
  rmSync(from, { recursive: true, force: true });
}
