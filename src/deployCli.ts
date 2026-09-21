/** The deploy owner exposes its stable CLI without rewriting user-managed bins. */
import { lstat, mkdir, open, readFile, readlink, rename, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const HEADER = "#!/bin/sh\n# Honeybee deploy CLI shim v1\n";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, "r");
  try { await fd.sync(); } finally { await fd.close(); }
}
async function pathState(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function exposeDeployedCli(runtimeRoot: string, binDirectory: string, interpreter: string): Promise<void> {
  const root = resolve(runtimeRoot), bin = resolve(binDirectory), shim = join(root, "hive"), link = join(bin, "hive");
  const existing = await pathState(link);
  if (existing && (!existing.isSymbolicLink() || await readlink(link) !== shim)) {
    return; // Keep user-managed commands, including dangling symlinks, intact.
  }
  const prior = await pathState(shim);
  if (prior && (!prior.isFile() || !(await readFile(shim, "utf8")).startsWith(HEADER))) throw new Error("deploy: runtime CLI shim is not owner-managed");
  const data = dirname(root);
  const content = HEADER + `exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 HIVE_STORE_ROOT=${quote(data)} HIVE_V2_DATA_DIR=${quote(join(data, "v2"))} ${quote(resolve(interpreter))} ${quote(join(root, "current", "dist", "cli.js"))} "$@"\n`;
  const temporary = join(root, `.hive-${randomUUID()}`);
  const fd = await open(temporary, "wx", 0o755);
  try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
  try { await rename(temporary, shim); await syncDirectory(root); }
  finally { await unlink(temporary).catch(() => undefined); }
  const first = await mkdir(bin, { recursive: true });
  if (first) {
    let directory = bin;
    for (;;) { await syncDirectory(directory); if (directory === dirname(first)) break; directory = dirname(directory); }
  }
  // symlink's exclusive creation preserves a concurrently installed user bin.
  if (!existing) await symlink(shim, link);
  await syncDirectory(bin);
}
