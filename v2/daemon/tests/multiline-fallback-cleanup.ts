import { createConnection } from "node:net";

export function ownedTmuxEndpointGone(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {socket.destroy(); reject(new Error("tmux_fixture_endpoint_timeout"));}, 100);
    socket.once("connect", () => {clearTimeout(timer); socket.destroy(); resolve(false);});
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer); socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(true);
      else reject(new Error("tmux_fixture_endpoint_error", {cause: error}));
    });
  });
}

export class TmuxFixtureCleanupError extends AggregateError {
  readonly code = "tmux_fixture_cleanup_failed";
  constructor(errors: unknown[]) {
    super(errors, "tmux_fixture_cleanup_failed", {cause: errors[0]});
  }
}

export async function cleanupTmuxFixture(steps: {
  disposeAll: () => void;
  killServer: () => void;
  serverAndPanesGone: () => boolean | Promise<boolean>;
  closeStore: () => void;
  removeRoot: () => void;
  timeoutMs?: number;
}): Promise<void> {
  const errors: unknown[] = [];
  let gone = false;
  try {
    try {steps.disposeAll();} catch (error) {errors.push(error);}
  } finally {
    try {
      try {steps.killServer();} catch (error) {errors.push(error);}
    } finally {
      try {
        const deadline = Date.now() + (steps.timeoutMs ?? 3000);
        do {
          if (await steps.serverAndPanesGone()) {gone = true; break;}
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        if (!gone) errors.push(new Error("tmux_fixture_cleanup_timeout"));
      } catch (error) {errors.push(error);}
      finally {
        try {steps.closeStore();} catch (error) {errors.push(error);}
        finally {
          if (gone) {
            try {steps.removeRoot();} catch (error) {errors.push(error);}
          }
        }
      }
    }
  }
  if (errors.length) throw new TmuxFixtureCleanupError(errors);
}
