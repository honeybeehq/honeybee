import { mkdtempSync } from "node:fs";
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

export function shortSocketDir(prefix: string, name: string, bases: Array<string | undefined> = [process.env.TMPDIR, "/tmp"]): string {
  const probes: string[] = [];
  for (const base of bases) {
    if (!base) continue;
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
