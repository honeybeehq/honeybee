import { dirname, parse, resolve } from "node:path";
import { ConfigError, defaultDataDir, loadNodeConfig, type ResolvedNodeConfig } from "./config.ts";

export interface DaemonRunArgs {
  dataDir?: string;
  configPath?: string;
  socketPath?: string;
}

export function parseDaemonRunArgs(argv: string[]): DaemonRunArgs {
  const out: DaemonRunArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new ConfigError("daemon run: --data-dir requires a non-empty path");
      out.dataDir = value;
    } else if (a === "--config") out.configPath = argv[++i];
    else if (a === "--socket") out.socketPath = argv[++i];
    else throw new Error(`daemon run: unknown argument '${a}'`);
  }
  return out;
}

export function resolveDaemonDataDir(args: DaemonRunArgs): string {
  const dataDir = args.dataDir ?? defaultDataDir();
  if (typeof dataDir !== "string" || dataDir.length === 0) throw new ConfigError("daemon run: --data-dir requires a non-empty path");
  const resolved = resolve(dataDir);
  if (resolved === parse(resolved).root || dirname(resolved) === parse(resolved).root) {
    throw Object.assign(new ConfigError("daemon run: --data-dir / HIVE_V2_DATA_DIR must use a nested directory, not the filesystem root or its direct child"), { code: "invalid_runtime_root" as const });
  }
  return resolved;
}

export function loadDaemonConfig(args: DaemonRunArgs, dataDir: string): ResolvedNodeConfig {
  const cfg = loadNodeConfig(dataDir, args.configPath);
  return args.socketPath ? { ...cfg, socketPath: resolve(args.socketPath) } : cfg;
}

export function resolveDaemonConfig(args: DaemonRunArgs): ResolvedNodeConfig {
  return loadDaemonConfig(args, resolveDaemonDataDir(args));
}
