import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UNIX_SOCKET_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;

export class SocketPathTooLongError extends Error {
  readonly code = "socket_path_too_long";
  readonly socketPath: string;
  readonly probes: string[];

  constructor(message: string, socketPath: string, probes: string[] = [socketPath]) {
    super(message);
    this.name = "SocketPathTooLongError";
    this.socketPath = socketPath;
    this.probes = probes;
  }
}

export function socketPathBytes(path: string): number {
  return Buffer.byteLength(path, "utf8");
}

export function socketPathFits(path: string): boolean {
  return socketPathBytes(path) < UNIX_SOCKET_PATH_LIMIT;
}

export function requireSocketPathFits(path: string, what: string): string {
  if (socketPathFits(path)) return path;
  throw new SocketPathTooLongError(
    `${what} socket path ${path} is ${socketPathBytes(path)} bytes; unix socket paths must stay under ${UNIX_SOCKET_PATH_LIMIT} bytes on ${process.platform}`,
    path,
  );
}

export function shortSocketDir(prefix: string, name: string, bases: Array<string | undefined> = [join(homedir(), ".hive", "s")]): string {
  const probes: string[] = [];
  for (const given of bases) {
    if (!given) continue;
    let base: string;
    try {
      base = realpathSync(given);
    } catch {
      continue;
    }
    const probe = join(base, `${prefix}XXXXXX`, name);
    probes.push(probe);
    if (!socketPathFits(probe)) continue;
    try {
      return mkdtempSync(join(base, prefix));
    } catch {
      continue;
    }
  }
  throw new SocketPathTooLongError(
    `no short directory can hold ${name}: ${probes.join(", ")} ${probes.length === 1 ? "exceeds" : "all exceed"} ${UNIX_SOCKET_PATH_LIMIT} bytes on ${process.platform} or cannot be created`,
    probes[0] ?? name,
    probes,
  );
}

export function ownedPrivateDir(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.geteuid?.() && (stat.mode & 0o777) === 0o700
      && realpathSync(path) === path;
  } catch {
    return false;
  }
}

/** Stable control sockets live outside the scratch/cache grants of Cell sandboxes. */
export function persistentSocketDir(dataDir: string, name: string, bases: Array<string | undefined> = [join(homedir(), ".hive", "s")]): string {
  const given = bases.find((path): path is string => !!path);
  const digest = createHash("sha256").update(realpathSync(dataDir)).digest("hex").slice(0, 12);
  if (!given) throw new SocketPathTooLongError("no private socket base", name);
  requireSocketPathFits(join(given, digest, name), "private control");
  mkdirSync(given, { recursive: true, mode: 0o700 });
  const base = realpathSync(given);
  if (!ownedPrivateDir(base)) throw new Error(`socket base is not a private real directory: ${base}`);
  const dir = join(base, digest);
  requireSocketPathFits(join(dir, name), "private control");
  mkdirSync(dir, { mode: 0o700, recursive: true });
  if (!ownedPrivateDir(dir)) throw new Error(`socket directory is not private: ${dir}`);
  writeFileSync(join(dataDir, "socket-dir"), `${dir}\n`, { mode: 0o600 });
  return dir;
}
