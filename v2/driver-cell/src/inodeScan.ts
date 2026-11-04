import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

export interface CellStorageIdentity {
  cellsRoot: string;
  wrapper: string;
  spaceDir: string;
  sandboxed: boolean;
}
export interface CellStorageScan {
  entries: number;
  files: number;
  milliseconds: number;
  wrapperDev: number;
  wrapperIno: number;
}
export class CellStorageRefused extends Error {
  readonly code = "cell_shared_inodes";
  constructor(reason: string) {
    super(`Cell storage validation refused (${reason}); preserve work, then copy to independent inodes or re-provision before enabling the sandbox`);
    this.name = "CellStorageRefused";
  }
}

export function scanCellStorage(identity: CellStorageIdentity, maxEntries = 250000, timeoutMs = 10000): CellStorageScan {
  const started = performance.now();
  const fail = (reason: string): never => { throw new CellStorageRefused(reason); };
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("invalid validation bounds");
  if (!isAbsolute(identity.cellsRoot) || resolve(identity.cellsRoot) !== identity.cellsRoot || !identity.wrapper || identity.wrapper.includes(sep) || identity.wrapper === "." || identity.wrapper === "..") fail("invalid stored identity");
  const wrapper = join(identity.cellsRoot, identity.wrapper);
  if (dirname(identity.spaceDir) !== wrapper || !relative(wrapper, identity.spaceDir) || resolve(identity.spaceDir) !== identity.spaceDir) fail("checkout does not belong to its wrapper");
  const directory = (path: string) => {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) fail("redirected directory");
    return info;
  };
  directory(identity.cellsRoot);
  const before = directory(wrapper);
  directory(identity.spaceDir);
  const git = join(identity.spaceDir, ".git"), objects = join(git, "objects");
  directory(git); directory(objects);
  if (lstatSync(join(objects, "info"), {throwIfNoEntry: false})) directory(join(objects, "info"));
  for (const path of [join(git, "commondir"), join(objects, "info", "alternates"), join(objects, "info", "http-alternates")]) {
    if (lstatSync(path, {throwIfNoEntry: false})) fail("redirected repository storage");
  }
  const seen = new Map<string, {links: number; count: number}>();
  const pending = [wrapper];
  let entries = 0, files = 0;
  while (pending.length) {
    if (performance.now() - started > timeoutMs) fail("validation deadline exceeded");
    const path = pending.pop()!;
    const info = lstatSync(path);
    if (++entries > maxEntries) fail("validation entry limit exceeded");
    if (info.isSymbolicLink()) {
      if (path.startsWith(objects + sep)) fail("redirected object storage");
      continue;
    }
    if (info.isDirectory()) {
      const directory = opendirSync(path);
      try {
        for (;;) {
          if (performance.now() - started > timeoutMs) fail("validation deadline exceeded");
          const entry = directory.readSync();
          if (!entry) break;
          if (pending.length + entries >= maxEntries) fail("validation entry limit exceeded");
          pending.push(join(path, entry.name));
        }
      } finally { directory.closeSync(); }
    } else if (info.isFile()) {
      files++;
      const key = `${info.dev}:${info.ino}`;
      const record = seen.get(key);
      if (record) {
        if (record.links !== info.nlink) fail("file links changed during validation");
        record.count++;
      } else seen.set(key, {links: info.nlink, count: 1});
    }
  }
  for (const record of seen.values()) if (record.count !== record.links) fail("file links leave the wrapper");
  const after = directory(wrapper);
  if (before.dev !== after.dev || before.ino !== after.ino) fail("wrapper changed during validation");
  return {entries, files, milliseconds: performance.now() - started, wrapperDev: before.dev, wrapperIno: before.ino};
}
