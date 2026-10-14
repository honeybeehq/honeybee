/**
 * Foreground daemon entry: `hive v2 daemon run [--data-dir d] [--config p]
 * [--socket s]`. This is what the rendered launchd plist / systemd unit
 * executes; it runs until SIGTERM/SIGINT and then shuts down cleanly
 * (children survive — the next boot re-adopts them).
 */
import { existsSync } from "node:fs";
import { measureDirectoryBytes } from "../../driver-cell/src/index.ts";
import { defaultDataDir, loadNodeConfig, type ResolvedNodeConfig } from "./config.ts";
import { HiveDaemon } from "./daemon.ts";

export interface DaemonRunArgs {
  dataDir?: string;
  configPath?: string;
  socketPath?: string;
}

export function parseDaemonRunArgs(argv: string[]): DaemonRunArgs {
  const out: DaemonRunArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a === "--config") out.configPath = argv[++i];
    else if (a === "--socket") out.socketPath = argv[++i];
    else throw new Error(`daemon run: unknown argument '${a}'`);
  }
  return out;
}

export function resolveDaemonConfig(args: DaemonRunArgs): ResolvedNodeConfig {
  const dataDir = args.dataDir ?? defaultDataDir();
  const cfg = loadNodeConfig(dataDir, args.configPath);
  return args.socketPath ? { ...cfg, socketPath: args.socketPath } : cfg;
}

/** Test daemons: a volume of `totalBytes` whose only occupant is the Cells root. */
function simulatedCellVolume(cellsRoot: string, totalBytes: number): (path: string) => { totalBytes: number; freeBytes: number } {
  return () => ({ totalBytes, freeBytes: Math.max(0, totalBytes - (existsSync(cellsRoot) ? measureDirectoryBytes(cellsRoot) : 0)) });
}

/** Run the daemon in the foreground until a termination signal. */
export async function runDaemon(argv: string[]): Promise<number> {
  const cfg = resolveDaemonConfig(parseDaemonRunArgs(argv));
  // Test daemons shorten the delay before the first automatic Cell retention pass.
  const retentionDelay = Number(process.env.HIVE_TEST_RETENTION_INITIAL_DELAY_MS);
  const diskCheckMs = Number(process.env.HIVE_TEST_CELL_DISK_CHECK_MS);
  const volumeBytes = Number(process.env.HIVE_TEST_CELL_VOLUME_BYTES);
  const pressureRetryMs = Number(process.env.HIVE_TEST_CELL_PRESSURE_RETRY_MS);
  const daemon = new HiveDaemon(cfg, {
    ...(Number.isFinite(retentionDelay) && retentionDelay >= 0 ? { retentionInitialDelayMs: retentionDelay } : {}),
    ...(Number.isFinite(diskCheckMs) && diskCheckMs > 0 ? { retentionDiskCheckMs: diskCheckMs } : {}),
    ...(Number.isFinite(pressureRetryMs) && pressureRetryMs > 0 ? { retentionPressureRetryMs: pressureRetryMs } : {}),
    ...(Number.isFinite(volumeBytes) && volumeBytes > 0 ? { retentionStatfs: simulatedCellVolume(cfg.cellsRoot, volumeBytes) } : {}),
  });
  // Test daemons deliberately own disposable stub runtimes. Production omits
  // this test-only flag so deploy/restart continues to preserve live bees.
  const reapTestRuntimes = process.env.HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN === "1";
  await daemon.start();
  process.stdout.write(`hived v2 listening on ${cfg.socketPath} (store ${cfg.storePath})\n`);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const onSignal = (): void => {
      if (stopping) return;
      stopping = true;
      void daemon.shutdown({ preserveRuntimes: !reapTestRuntimes }).then(() => {
        setTimeout(() => {
          const resources = process.getActiveResourcesInfo().reduce<Record<string, number>>((counts, name) => {
            counts[name] = (counts[name] ?? 0) + 1;
            return counts;
          }, {});
          process.stderr.write(`hived shutdown exit backstop pid=${process.pid} resources=${JSON.stringify(resources)}\n`);
          process.exit(0);
        }, 1000).unref();
        resolve();
      });
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  });
  return 0;
}
