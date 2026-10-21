import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistentSocketDir, requireSocketPathFits, shortSocketDir as pickShortSocketDir, socketPathFits, SocketPathTooLongError, UNIX_SOCKET_PATH_LIMIT } from "../../core/src/socketPath.ts";
import { RpcError } from "./protocol.ts";

export { ownedPrivateDir, socketPathBytes, socketPathFits, UNIX_SOCKET_PATH_LIMIT } from "../../core/src/socketPath.ts";
export const SOCKET_DIR_RECORD_FILE = "socket-dir";
export const RUNNER_SOCKET_SAMPLE = join(`hb-rh-${"0".repeat(16)}`, "stdin.sock");

export interface SocketPlacement {
  socketPath: string;
  tmuxSocketPath: string;
  runnerSocketDir: string;
  socketDir: string | null;
}

function typed<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof SocketPathTooLongError) {
      throw new RpcError("socket_path_too_long", error.message, { socketPath: error.socketPath, probes: error.probes, limit: UNIX_SOCKET_PATH_LIMIT });
    }
    throw error;
  }
}

export function assertSocketPathFits(path: string, what: string): string {
  return typed(() => requireSocketPathFits(path, what));
}

export function shortSocketDir(prefix: string, name: string, bases?: Array<string | undefined>): string {
  return typed(() => pickShortSocketDir(prefix, name, bases));
}

export function placeDaemonSockets(
  dataDir: string,
  configuredSocketPath: string,
  options: { runnerSocketDir?: string; bases?: Array<string | undefined> } = {},
): SocketPlacement {
  const defaultSocket = join(dataDir, "hived.sock");
  const explicit = configuredSocketPath !== defaultSocket;
  if (explicit) assertSocketPathFits(configuredSocketPath, "configured daemon");
  const tmuxDefault = join(dataDir, "tmux.sock");
  const runnerDefault = options.runnerSocketDir ?? tmpdir();
  const socketFits = explicit || socketPathFits(defaultSocket);
  const tmuxFits = socketPathFits(tmuxDefault);
  const runnerFits = socketPathFits(join(runnerDefault, RUNNER_SOCKET_SAMPLE));
  if (socketFits && tmuxFits && runnerFits) {
    return { socketPath: configuredSocketPath, tmuxSocketPath: tmuxDefault, runnerSocketDir: runnerDefault, socketDir: null };
  }
  const dir = typed(() => persistentSocketDir(dataDir, RUNNER_SOCKET_SAMPLE, options.bases));
  return {
    socketPath: socketFits ? configuredSocketPath : assertSocketPathFits(join(dir, "hived.sock"), "daemon"),
    tmuxSocketPath: tmuxFits ? tmuxDefault : assertSocketPathFits(join(dir, "tmux.sock"), "tmux"),
    runnerSocketDir: runnerFits ? runnerDefault : dir,
    socketDir: dir,
  };
}
