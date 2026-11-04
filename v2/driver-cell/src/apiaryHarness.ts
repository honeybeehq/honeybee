import { lstatSync, realpathSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";

const HARNESSES = Object.freeze({codex: "codex", claude: "claude"});
const EXCLUDED = new Set(["grok", "opencode", "kimi", "muse"]);
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

function trusted(info: {uid: number; mode: number}, uid: number, symlink = false): void {
  if (info.uid === 65534 || info.uid !== 0 && info.uid !== uid) throw new Error("cell sandbox: harness leaf owner refused");
  if (!symlink && (info.mode & 0o6022) !== 0) throw new Error("cell sandbox: harness leaf writable or privileged mode refused");
}

export function validateHarnessLeaf(root: string, uid: number): void {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error("cell sandbox: harness leaf identity refused");
  const pending = [{path: root, depth: 0}];
  const seen = new Set<string>();
  let count = 0, bytes = 0;
  while (pending.length) {
    const {path, depth} = pending.pop()!;
    if (++count > 10000 || depth > 32) throw new Error("cell sandbox: harness leaf tree limit exceeded");
    const info = lstatSync(path);
    trusted(info, uid, info.isSymbolicLink());
    if (info.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!inside(root, target)) throw new Error("cell sandbox: harness leaf symlink escapes");
      pending.push({path: target, depth: depth + 1});
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) pending.push({path: join(path, name), depth: depth + 1});
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > 512 * 1024 * 1024) throw new Error("cell sandbox: harness leaf byte limit exceeded");
    } else throw new Error("cell sandbox: harness leaf special entry refused");
  }
}

export interface ApiaryHarnessProjection { id: "codex" | "claude"; leaf: string; executable: string; alias: string }

export function apiaryHarnessProjection(command: string, args: readonly string[], home: string, uid: number, hint?: string): ApiaryHarnessProjection | null {
  const base = join(home, ".local", "share", "apiary-satellite");
  let id = hint;
  if (!id && (Object.hasOwn(HARNESSES, basename(command)) || EXCLUDED.has(basename(command)))) id = basename(command);
  for (const input of [command, ...args]) {
    if (!isAbsolute(input) || !inside(base, input)) continue;
    const parts = relative(base, input).split(sep);
    const candidate = parts[0] === "bin" ? parts[1] : parts[0] === "tools" ? parts[1] : undefined;
    if (candidate) {
      if (id && id !== candidate) throw new Error("cell sandbox: multiple harness leaves refused");
      id = candidate;
    }
  }
  if (!id) return null;
  if (!Object.hasOwn(HARNESSES, id)) throw new Error(`cell sandbox: harness '${id}' is excluded from sandboxed Cells; only codex and claude are supported`);
  const refusal = () => new Error(`cell sandbox: ${id} requires an approved Apiary-managed harness leaf; refusing launch`);
  for (const path of [home, join(home, ".local"), join(home, ".local", "share"), base, join(base, "bin"), join(base, "tools"), join(base, "tools", id)]) {
    const info = lstatSync(path, {throwIfNoEntry: false});
    if (!info?.isDirectory() || info.isSymbolicLink()) throw refusal();
    trusted(info, uid);
  }
  const link = join(base, "bin", id);
  const linkInfo = lstatSync(link, {throwIfNoEntry: false});
  if (!linkInfo?.isSymbolicLink()) throw refusal();
  trusted(linkInfo, uid, true);
  const executable = realpathSync(link);
  const parts = relative(join(base, "tools", id), executable).split(sep);
  if (parts.length < 2 || !VERSION.test(parts[0]!)) throw refusal();
  const leaf = join(base, "tools", id, parts[0]!);
  if (!inside(leaf, executable) || realpathSync(leaf) !== leaf) throw refusal();
  const info = lstatSync(executable);
  if (!info.isFile() || (info.mode & 0o111) === 0) throw refusal();
  for (const input of [command, ...args]) {
    if (!isAbsolute(input) || !inside(base, input) || input === link) continue;
    if ((relative(base, input).split(sep)[0] === "tools") && !inside(leaf, realpathSync(input))) throw refusal();
  }
  const launchInputs = [command, ...args];
  if (command !== id && !launchInputs.some(input => isAbsolute(input) && lstatSync(input, {throwIfNoEntry: false}) && inside(leaf, realpathSync(input)))) throw refusal();
  validateHarnessLeaf(leaf, uid);
  return {id: id as "codex" | "claude", leaf, executable, alias: `/run/honeybee/tools/bin/${id}`};
}

export interface NodeProjection { files: string[]; packages: string[]; links: {path: string; target: string}[] }

export function nodeReadOnlyProjection(root: string, uid: number): NodeProjection {
  const files: string[] = [], packages: string[] = [], links: {path: string; target: string}[] = [];
  for (const path of [root, join(root, "bin")]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new Error("cell sandbox: Node projection directory refused");
    trusted(info, uid);
  }
  const node = join(root, "bin", "node");
  const nodeInfo = lstatSync(node);
  if (!nodeInfo.isFile() || nodeInfo.isSymbolicLink() || (nodeInfo.mode & 0o111) === 0) throw new Error("cell sandbox: Node projection executable refused");
  trusted(nodeInfo, uid);
  files.push(node);
  for (const name of ["npm", "corepack"]) {
    const path = join(root, "lib", "node_modules", name);
    if (!lstatSync(path, {throwIfNoEntry: false})) continue;
    for (const ancestor of [join(root, "lib"), join(root, "lib", "node_modules")]) {
      const info = lstatSync(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("cell sandbox: Node package ancestor refused");
      trusted(info, uid);
    }
    validateHarnessLeaf(path, uid);
    packages.push(path);
  }
  for (const name of ["npm", "npx", "corepack"]) {
    const path = join(root, "bin", name);
    const info = lstatSync(path, {throwIfNoEntry: false});
    if (!info) continue;
    trusted(info, uid, info.isSymbolicLink());
    const target = realpathSync(path);
    const packageRoot = join(root, "lib", "node_modules", name === "npx" ? "npm" : name);
    if (!packages.includes(packageRoot) || !inside(packageRoot, target) || !lstatSync(target).isFile()) throw new Error("cell sandbox: Node launcher target refused");
    links.push({path, target});
  }
  return {files, packages, links};
}
