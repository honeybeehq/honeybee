import { homedir } from "node:os";
import type { LoginCliFacts, LoginFlowError } from "../../core/src/loginFlow.ts";
import { CURSOR_AGENT_VERSION, cursorBundledAgentPaths, firstRunnableCommand, type RunnableCommandSearch } from "./login/runnableCommand.ts";

export const CURSOR_CLI_MIN_VERSION = "2026.06.02";
export const CURSOR_CLI_INSTALL = "curl https://cursor.com/install -fsS | bash";
const INSTALL_AGENT = `Install Cursor's agent CLI (${CURSOR_CLI_INSTALL}), or point this agent's configured command at it, then start again.`;

function releaseDay(version: string): string {
  return version.split("-")[0]!.split(".").map((part, index) => index === 0 ? part : part.padStart(2, "0")).join(".");
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

export function cursorCliFacts(search: RunnableCommandSearch, minVersion: string | null): LoginCliFacts | null {
  if (search.path && search.version) {
    if (minVersion === null || releaseDay(search.version) >= releaseDay(minVersion)) return null;
    return { reason: "too_old", path: search.path, version: search.version, minVersion, tried: search.tried, fix: `${shellQuote(search.path)} update` };
  }
  const launcher = search.otherPrograms[0];
  if (launcher) return { reason: "not_agent", path: launcher.path, version: launcher.version, minVersion, tried: search.tried, fix: CURSOR_CLI_INSTALL };
  return { reason: "missing", path: null, version: null, minVersion, tried: search.tried, fix: CURSOR_CLI_INSTALL };
}

function refusalMessage(cli: LoginCliFacts, launcherCandidate: string | undefined): string {
  switch (cli.reason) {
    case "too_old":
      return `Cursor's agent CLI ${cli.path} reports version ${cli.version}; Honeybee needs ${cli.minVersion} or newer, so a Honeybee token never rewrites or clears this computer's own Cursor login. Update Cursor's agent CLI (${cli.fix}), then start again.`;
    case "not_agent":
      return `${launcherCandidate} is the Cursor app's launcher (it printed ${JSON.stringify(cli.version)}), not Cursor's agent CLI, and no Cursor agent CLI was found (tried ${cli.tried.join(", ")}). ${INSTALL_AGENT}`;
    case "missing":
      return `No Cursor agent CLI was found on this node (tried ${cli.tried.join(", ")}). ${INSTALL_AGENT}`;
  }
}

export async function cursorAgentForSpawn(command: string, env: Record<string, string | undefined>): Promise<{ path: string } | { refusal: LoginFlowError }> {
  const candidates = [...new Set([command, "agent", "cursor-agent", ...cursorBundledAgentPaths(process.platform, env.HOME ?? homedir())])];
  const search = await firstRunnableCommand(candidates, env as Record<string, string>, { versionPattern: CURSOR_AGENT_VERSION });
  const cli = cursorCliFacts(search, CURSOR_CLI_MIN_VERSION);
  if (!cli) return { path: search.path! };
  return { refusal: { code: "cli_missing", message: refusalMessage(cli, search.otherPrograms[0]?.candidate), cli } };
}
