import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export function storeRoot(): string {
  return process.env.HIVE_STORE_ROOT ?? join(homedir(), ".hive");
}

export type AtomicWriteOptions = {
  mode?: number;
};

let atomicWriteCounter = 0;

export async function atomicWriteFile(path: string, data: string | Buffer, options: AtomicWriteOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  atomicWriteCounter += 1;
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${atomicWriteCounter}.tmp`);
  await writeFile(tmp, data, options.mode !== undefined ? { mode: options.mode } : undefined);
  await rename(tmp, path);
}
