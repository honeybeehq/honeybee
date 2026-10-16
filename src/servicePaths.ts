import { isAbsolute, join } from "node:path";

export function serviceDirectory(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HIVE_V2_SERVICE_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error("HIVE_V2_SERVICE_DIR must be absolute");
    return override;
  }
  if (platform === "linux" && env.XDG_CONFIG_HOME) {
    if (!isAbsolute(env.XDG_CONFIG_HOME)) throw new Error("XDG_CONFIG_HOME must be absolute");
    return join(env.XDG_CONFIG_HOME, "systemd", "user");
  }
  const home = env.HOME;
  if (!home || !isAbsolute(home)) throw new Error("HOME required for the service directory");
  return platform === "darwin" ? join(home, "Library", "LaunchAgents") : join(home, ".config", "systemd", "user");
}
