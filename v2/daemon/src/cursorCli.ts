import { resolveExecutable } from "../../core/src/executables.ts";
import { CURSOR_AGENT_VERSION, commandVersion } from "./login/runnableCommand.ts";

export const CURSOR_CLI_MIN_VERSION = "2026.06.02";

function releaseDay(version: string): string {
  return version.split("-")[0]!.split(".").map((part, index) => index === 0 ? part : part.padStart(2, "0")).join(".");
}

export async function cursorCliRefusal(command: string, env: Record<string, string | undefined>): Promise<string | null> {
  const resolved = resolveExecutable(command, { env });
  const version = resolved ? await commandVersion(resolved.path, env as Record<string, string>, 5_000) : null;
  const why = `Honeybee needs ${CURSOR_CLI_MIN_VERSION} or newer, so a Honeybee token never rewrites or clears this computer's own Cursor login. Update Cursor's CLI, then start again.`;
  if (version === null || !CURSOR_AGENT_VERSION.test(version)) {
    return `Cursor CLI ${command} did not report a Cursor agent version${version === null ? " (it did not run)" : ` (${JSON.stringify(version.slice(0, 80))})`}; ${why}`;
  }
  if (releaseDay(version) < releaseDay(CURSOR_CLI_MIN_VERSION)) return `Cursor CLI ${command} reports version ${version}; ${why}`;
  return null;
}
