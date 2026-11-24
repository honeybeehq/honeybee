import { resolve, sep } from "node:path";

const HOST_BEE_IDENTITY_KEYS = [
  "HIVE_V2_DATA_DIR",
  "HIVE_V2_SOCKET_PATH",
  "HIVE_SCRATCH",
  "HIVE_CELL",
  "HIVE_CELL_SPACE",
  "HIVE_BEE",
  "HIVE_BEE_ID",
  "HIVE_PARENT",
] as const;

const HOST_BEE_IDENTITY_PREFIXES = ["HIVE_NODE_"] as const;

const HOST_BEE_TMP_KEYS = ["TMPDIR", "CLAUDE_CODE_TMPDIR"] as const;

function isWithinDirectory(path: string, directory: string): boolean {
  const root = resolve(directory);
  const candidate = resolve(path);
  return candidate === root || candidate.startsWith(root + sep);
}

export function hostBeeKeysIn(env: NodeJS.ProcessEnv): string[] {
  const scratch = env.HIVE_SCRATCH;
  return Object.keys(env).filter((key) =>
    (HOST_BEE_IDENTITY_KEYS as readonly string[]).includes(key)
    || HOST_BEE_IDENTITY_PREFIXES.some((prefix) => key.startsWith(prefix))
    || (scratch !== undefined && scratch !== "" && (HOST_BEE_TMP_KEYS as readonly string[]).includes(key) && isWithinDirectory(env[key] ?? "", scratch)),
  );
}

export function labInheritedEnv(hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const inherited = { ...hostEnv };
  for (const key of hostBeeKeysIn(hostEnv)) delete inherited[key];
  return inherited;
}

export function scrubHostBeeEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of hostBeeKeysIn(env)) delete env[key];
}

scrubHostBeeEnv();
