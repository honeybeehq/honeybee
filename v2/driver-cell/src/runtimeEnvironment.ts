const CELL_DAEMON_KEYS = new Set([
  "PATH", "LANG", "TZ", "TERM", "HOME", "USER", "LOGNAME", "TMPDIR",
  "LC_ALL", "LC_ADDRESS", "LC_COLLATE", "LC_CTYPE", "LC_IDENTIFICATION", "LC_MEASUREMENT",
  "LC_MESSAGES", "LC_MONETARY", "LC_NAME", "LC_NUMERIC", "LC_PAPER", "LC_TELEPHONE", "LC_TIME",
]);
const HOST_ROUTES = ["HIVE_SOCKET", "HIVE_DATA_DIR", "HIVE_V2_SOCKET_PATH", "HIVE_V2_DATA_DIR", "HIVE_TMUX_SOCKET", "HIVE_TMUX_SOCKET_PATH"];

export function cellDaemonEnvironment(source: Readonly<Record<string, string | undefined>>, dropped?: (names: string[]) => void): Record<string, string> {
  const env: Record<string, string> = {};
  const names: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CELL_DAEMON_KEYS.has(name)) env[name] = value;
    else names.push(name);
  }
  if (names.length) dropped?.(names.sort());
  return env;
}

export function withoutCellHostRoutes(source: Readonly<Record<string, string>>): Record<string, string> {
  const env = {...source};
  for (const name of HOST_ROUTES) delete env[name];
  return env;
}
