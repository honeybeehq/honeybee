import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function assertApiaryToolchainMetadata(info: {uid: number; mode: number}, uid: number): void {
  if (info.uid === 65534 || info.uid !== uid) throw new Error("cell sandbox: Apiary toolchain owner refused");
  if ((info.mode & 0o022) !== 0) throw new Error("cell sandbox: Apiary toolchain writable mode refused");
}

export function apiaryToolchainRoot(executable: string, home: string, uid: number): string | null {
  const base = join(home, ".local", "share", "apiary-satellite");
  const rel = relative(base, executable);
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) return null;
  const match = /^(node-v[0-9]+\.[0-9]+\.[0-9]+-linux-(?:x64|arm64))\/bin\/node$/.exec(rel);
  if (!match) throw new Error("cell sandbox: Apiary toolchain name refused");
  const root = join(base, match[1]!);
  for (const path of [home, join(home, ".local"), join(home, ".local", "share"), base, root, join(root, "bin")]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("cell sandbox: Apiary toolchain ancestor refused");
    assertApiaryToolchainMetadata(info, uid);
  }
  const pending = [{path: root, depth: 0}];
  let entries = 0;
  let bytes = 0;
  const seen = new Set<string>();
  while (pending.length) {
    const {path, depth} = pending.pop()!;
    if (++entries > 10000 || depth > 16) throw new Error("cell sandbox: Apiary toolchain tree exceeds limit");
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      if (info.uid !== uid) throw new Error("cell sandbox: Apiary toolchain owner refused");
      const target = realpathSync(path);
      const targetRelative = relative(root, target);
      if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || targetRelative.startsWith(sep)) throw new Error("cell sandbox: Apiary toolchain link escapes leaf");
      pending.push({path: target, depth: depth + 1});
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (!info.isDirectory() && !info.isFile()) throw new Error("cell sandbox: Apiary toolchain entry refused");
    assertApiaryToolchainMetadata(info, uid);
    if ((info.mode & 0o6000) !== 0) throw new Error("cell sandbox: Apiary toolchain privileged mode refused");
    bytes += info.isFile() ? info.size : 0;
    if (bytes > 512 * 1024 * 1024) throw new Error("cell sandbox: Apiary toolchain byte limit exceeded");
    if (info.isDirectory()) for (const name of readdirSync(path)) pending.push({path: join(path, name), depth: depth + 1});
  }
  const node = lstatSync(executable);
  if (!node.isFile() || (node.mode & 0o111) === 0) throw new Error("cell sandbox: Apiary Node executable refused");
  return root;
}
