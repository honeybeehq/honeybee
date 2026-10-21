import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export const PINNED_ACCOUNT = "claude-claude-trmd-trmd.me";
export interface RuntimePolicy {
  version: 1;
  enabled: true;
  realHomeApproved: true;
  refreshProof: { passed: true; proofId: string; account: string; cliPath: string };
  cliPath: string;
  allowedTools: string[];
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  identity: string;
}
export class LaunchRefusal extends Error {
  readonly code = "champion_sdk_refused";
}
export function readPolicy(path: string): RuntimePolicy {
  try {
    const r = JSON.parse(readFileSync(path, "utf8"));
    if (r.version !== 1 || r.enabled !== true || r.realHomeApproved !== true) throw new Error();
    if (r.refreshProof?.passed !== true || typeof r.refreshProof.proofId !== "string" || !r.refreshProof.proofId || r.refreshProof.account !== PINNED_ACCOUNT) throw new Error();
    if (typeof r.cliPath !== "string" || !isAbsolute(r.cliPath) || realpathSync(r.cliPath) !== realpathSync(r.refreshProof.cliPath)) throw new Error();
    if (!Array.isArray(r.allowedTools) || !r.allowedTools.every((t: unknown) => typeof t === "string" && /^mcp__apiary__[a-zA-Z0-9_]+$/.test(t))) throw new Error();
    if (!r.mcpServers || Object.keys(r.mcpServers).join() !== "apiary") throw new Error();
    const server = r.mcpServers.apiary;
    if (!server || typeof server.command !== "string" || !isAbsolute(server.command) || !Array.isArray(server.args) || !server.args.every((s: unknown) => typeof s === "string") || server.env !== undefined) throw new Error();
    if (typeof r.identity !== "string" || !r.identity) throw new Error();
    return r as RuntimePolicy;
  } catch { throw new LaunchRefusal("Champion SDK disabled or Studio refresh proof/real-HOME approval missing"); }
}
export function assertStudio(platform: string, node: string, account: string | null, autoswapOff: boolean): void {
  if (platform !== "darwin" || node.split(".")[0] !== "Tormods-Mac-Studio" || account !== PINNED_ACCOUNT || !autoswapOff) {
    throw new LaunchRefusal("Champion SDK requires Studio, pinned Claude account and autoswap=false");
  }
}
const GATEWAY_KEYS = new Set(["APIARY_GATEWAY", "APIARY_GATEWAY_URL", "APIARY_SESSION_ID", "APIARY_AGENT_TOKEN"]);
const IDENTITY_KEYS = new Set(["HIVE_BEE", "HIVE_BEE_ID", "HIVE_PARENT", "HIVE_V2_DATA_DIR", "HIVE_V2_ENDPOINT", "HIVE_SESSION_ID", "HIVE_NODE_ID"]);
export function runtimeEnv(source: Record<string, string | undefined>, configDir: string, privateTmp: string): Record<string, string> {
  const env: Record<string, string> = { HOME: "/Users/trmd", CLAUDE_CONFIG_DIR: configDir, TMPDIR: privateTmp, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (IDENTITY_KEYS.has(key) || GATEWAY_KEYS.has(key))) env[key] = value;
  }
  return env;
}
export function sandboxProfile(paths: string[]): string {
  if (paths.some(path => !isAbsolute(path) || /[\n\r\0]/.test(path))) throw new LaunchRefusal("Invalid sandbox write path");
  return `(version 1) (allow default) (deny file-write*) (allow file-write* ${paths.map(path => `(subpath ${JSON.stringify(path)})`).join(" ")})`;
}
