import { homedir } from "node:os";
import { CURSOR_AGENT_VERSION, cursorBundledAgentPaths, firstRunnableCommand } from "./login/runnableCommand.ts";

export const CURSOR_CLI_MIN_VERSION = "2026.06.02";
const INSTALL_AGENT = "Install Cursor's agent CLI (curl https://cursor.com/install -fsS | bash), or point this agent's configured command at it, then start again.";

function releaseDay(version: string): string {
  return version.split("-")[0]!.split(".").map((part, index) => index === 0 ? part : part.padStart(2, "0")).join(".");
}

export async function cursorAgentForSpawn(command: string, env: Record<string, string | undefined>): Promise<{ path: string } | { refusal: string }> {
  const candidates = [...new Set([command, "agent", "cursor-agent", ...cursorBundledAgentPaths(process.platform, env.HOME ?? homedir())])];
  const search = await firstRunnableCommand(candidates, env as Record<string, string>, { versionPattern: CURSOR_AGENT_VERSION });
  if (search.path && search.version) {
    if (releaseDay(search.version) >= releaseDay(CURSOR_CLI_MIN_VERSION)) return { path: search.path };
    return { refusal: `Cursor's agent CLI ${search.path} reports version ${search.version}; Honeybee needs ${CURSOR_CLI_MIN_VERSION} or newer, so a Honeybee token never rewrites or clears this computer's own Cursor login. Update Cursor's agent CLI (cursor-agent update), then start again.` };
  }
  const launcher = search.otherPrograms[0];
  if (launcher) {
    return { refusal: `${launcher.candidate} is the Cursor app's launcher (it printed ${JSON.stringify(launcher.version)}), not Cursor's agent CLI, and no Cursor agent CLI was found (tried ${search.tried.join(", ")}). ${INSTALL_AGENT}` };
  }
  return { refusal: `No Cursor agent CLI was found on this node (tried ${search.tried.join(", ")}). ${INSTALL_AGENT}` };
}
