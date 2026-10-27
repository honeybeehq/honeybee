import type { ChildProcess } from "node:child_process";

export const RUNNER_EXIT_DRAIN_MS = 1_000;

export function observeRunnerExit(
  child: ChildProcess,
  finish: (code: number | null, signal: NodeJS.Signals | null, outputDrainTimedOut: boolean) => void,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  child.once("exit", (code, signal) => {
    child.stdin?.destroy();
    timer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(code, signal, true);
    }, RUNNER_EXIT_DRAIN_MS);
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    finish(code, signal, false);
  });
}
