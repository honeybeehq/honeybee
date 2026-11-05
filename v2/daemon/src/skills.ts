import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { RpcError } from "./protocol.ts";

export const SKILLS_MANIFEST = ".hive-skills.json";
export const MAX_SKILL_TREE_ENTRIES = 10_000;
export const MAX_SKILL_TREE_BYTES = 64 * 1024 * 1024;
export const MAX_SKILL_PATH_LENGTH = 512;

export interface SkillTreeFile {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
}

export interface ParsedSkillTree {
  digest: string;
  files: SkillTreeFile[];
  bytes: number;
  contents: Map<string, Buffer>;
}

export interface SkillsManifest {
  schema: 1;
  digest: string;
  files: SkillTreeFile[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** The content hash of a tree: sha256 over its sorted entries, one line each: `<sha256> <x|-> <path>`. */
export function skillTreeDigest(files: readonly SkillTreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.sha256} ${file.executable ? "x" : "-"} ${file.path}\n`);
  }
  return hash.digest("hex");
}

export function skillPathRefusal(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "path must be a non-empty string";
  if (path.length > MAX_SKILL_PATH_LENGTH) return `path must be at most ${MAX_SKILL_PATH_LENGTH} characters`;
  if (path.includes("\0") || path.includes("\\")) return "path must not contain NUL or backslash";
  if (path.startsWith("/")) return "path must be relative";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return "path must not contain empty, . or .. segments";
    if (segment.startsWith(".hive-")) return "path must not use the .hive- prefix Honeybee reserves";
  }
  return null;
}

function refuse(reason: string, message: string, index?: number): never {
  throw new RpcError("invalid_request", `skills.install: ${message}`, { reason, ...(index === undefined ? {} : { index }) });
}

/** Validate the wire tree: every entry's bytes hash to its sha256 and the tree digest is the digest of those entries. */
export function parseSkillTree(raw: unknown): ParsedSkillTree {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("tree", "tree must be an object");
  const tree = raw as Record<string, unknown>;
  if (typeof tree.digest !== "string" || !SHA256_HEX.test(tree.digest)) refuse("digest", "tree.digest must be a lower-case sha256 hex digest");
  if (!Array.isArray(tree.entries)) refuse("entries", "tree.entries must be an array");
  if (tree.entries.length > MAX_SKILL_TREE_ENTRIES) refuse("entries", `tree.entries must hold at most ${MAX_SKILL_TREE_ENTRIES} files`);
  const files: SkillTreeFile[] = [];
  const contents = new Map<string, Buffer>();
  let bytes = 0;
  tree.entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) refuse("entry", `entry ${index} must be an object`, index);
    const record = entry as Record<string, unknown>;
    const pathRefusal = skillPathRefusal(record.path);
    if (pathRefusal) refuse("path", `entry ${index}: ${pathRefusal}`, index);
    const path = record.path as string;
    if (contents.has(path)) refuse("path", `entry ${index}: ${path} appears twice`, index);
    if (typeof record.sha256 !== "string" || !SHA256_HEX.test(record.sha256)) refuse("sha256", `entry ${index}: sha256 must be a lower-case sha256 hex digest`, index);
    if (record.executable !== undefined && typeof record.executable !== "boolean") refuse("executable", `entry ${index}: executable must be a boolean`, index);
    if (typeof record.content !== "string") refuse("content", `entry ${index}: content must be a base64 string`, index);
    const content = Buffer.from(record.content, "base64");
    if (content.toString("base64").replace(/=+$/u, "") !== record.content.replace(/=+$/u, "")) refuse("content", `entry ${index}: content is not valid base64`, index);
    if (typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0 || record.size !== content.length) refuse("size", `entry ${index}: size must equal the decoded content length (${content.length})`, index);
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== record.sha256) refuse("sha256", `entry ${index}: content hashes to ${actual}, not ${record.sha256}`, index);
    bytes += content.length;
    if (bytes > MAX_SKILL_TREE_BYTES) refuse("bytes", `tree exceeds ${MAX_SKILL_TREE_BYTES} bytes`);
    files.push({ path, sha256: record.sha256, size: content.length, executable: record.executable === true });
    contents.set(path, content);
  });
  const digest = skillTreeDigest(files);
  if (digest !== tree.digest) refuse("digest", `tree.digest ${tree.digest} does not match the entries, which hash to ${digest}`);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { digest, files, bytes, contents };
}

export function skillTreeDir(skillsRoot: string, digest: string): string {
  return join(skillsRoot, digest);
}

function manifestText(digest: string, files: readonly SkillTreeFile[]): string {
  return `${JSON.stringify({ schema: 1, digest, files: [...files] } satisfies SkillsManifest, null, 2)}\n`;
}

export function readSkillsManifest(dir: string): SkillsManifest | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, SKILLS_MANIFEST), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.schema !== 1 || typeof record.digest !== "string" || !SHA256_HEX.test(record.digest) || !Array.isArray(record.files)) return null;
    const files: SkillTreeFile[] = [];
    for (const entry of record.files) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const file = entry as Record<string, unknown>;
      if (skillPathRefusal(file.path) !== null || typeof file.sha256 !== "string" || !SHA256_HEX.test(file.sha256) || typeof file.size !== "number" || typeof file.executable !== "boolean") return null;
      files.push({ path: file.path as string, sha256: file.sha256, size: file.size, executable: file.executable });
    }
    return { schema: 1, digest: record.digest, files };
  } catch {
    return null;
  }
}

function writeFileAtomically(path: string, data: Buffer | string, executable: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.hive-tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmp, data, { mode: executable ? 0o700 : 0o600 });
  renameSync(tmp, path);
}

/** Keep the node's own copy of a tree under `<skillsRoot>/<digest>/` so a home activated later gets it without Apiary. */
export function storeSkillTree(skillsRoot: string, tree: ParsedSkillTree): string {
  const dir = skillTreeDir(skillsRoot, tree.digest);
  if (readSkillsManifest(dir)?.digest === tree.digest) return dir;
  mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
  const staging = `${dir}.staging.${process.pid}.${Date.now()}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const file of tree.files) writeFileAtomically(join(staging, file.path), tree.contents.get(file.path)!, file.executable);
  writeFileAtomically(join(staging, SKILLS_MANIFEST), manifestText(tree.digest, tree.files), false);
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  return dir;
}

function removeEmptyParents(path: string, stopAt: string): void {
  let dir = dirname(path);
  while (dir.startsWith(stopAt + sep) && dir !== stopAt) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/**
 * Install the stored tree into `<homePath>/skills`: every file of the tree is
 * written (atomically, content from the node's copy), files the previous
 * manifest installed but the tree no longer has are removed, anything the
 * manifest never listed is left alone, and the manifest records the digest.
 * A home whose manifest already names the digest is left untouched.
 */
export function installSkillTreeIntoHome(treeDir: string, homePath: string): { status: "installed" | "unchanged"; digest: string; files: number } {
  const stored = readSkillsManifest(treeDir);
  if (!stored) throw new Error(`skills: stored tree at ${treeDir} has no manifest`);
  const skillsDir = join(homePath, "skills");
  const current = readSkillsManifest(skillsDir);
  if (current?.digest === stored.digest) return { status: "unchanged", digest: stored.digest, files: stored.files.length };
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  const root = resolve(skillsDir);
  const keep = new Set(stored.files.map((file) => file.path));
  for (const file of stored.files) {
    const target = resolve(root, file.path);
    const same = current?.files.find((prior) => prior.path === file.path);
    if (same && same.sha256 === file.sha256 && same.executable === file.executable && existsSync(target)) {
      try {
        const stat = statSync(target);
        if (stat.isFile() && stat.size === file.size) continue;
      } catch {}
    }
    writeFileAtomically(target, readFileSync(join(treeDir, file.path)), file.executable);
    if (!file.executable) chmodSync(target, 0o600);
  }
  for (const prior of current?.files ?? []) {
    if (keep.has(prior.path)) continue;
    const target = resolve(root, prior.path);
    rmSync(target, { force: true });
    removeEmptyParents(target, root);
  }
  writeFileAtomically(join(skillsDir, SKILLS_MANIFEST), manifestText(stored.digest, stored.files), false);
  return { status: "installed", digest: stored.digest, files: stored.files.length };
}

/** Read a directory into the wire tree shape (the CLI edge and callers that hold the tree on disk). */
export function readSkillTreeFromDirectory(dir: string): { digest: string; entries: Array<{ path: string; sha256: string; size: number; executable: boolean; content: string }> } {
  const entries: Array<{ path: string; sha256: string; size: number; executable: boolean; content: string }> = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relPath = rel ? `${rel}/${name.name}` : name.name;
      if (name.name === SKILLS_MANIFEST && !rel) continue;
      if (name.isDirectory()) walk(relPath);
      else if (name.isFile()) {
        const content = readFileSync(join(dir, relPath));
        const executable = (statSync(join(dir, relPath)).mode & 0o100) !== 0;
        entries.push({ path: relPath, sha256: createHash("sha256").update(content).digest("hex"), size: content.length, executable, content: content.toString("base64") });
      }
    }
  };
  walk("");
  return { digest: skillTreeDigest(entries), entries };
}
