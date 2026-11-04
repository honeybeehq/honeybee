import { validateDaemonNode } from "../../../src/nodeRuntime.ts";
import { ForegroundScheduling } from "../../../src/processScheduling.ts";
/**
 * Foreground daemon entry: `hive v2 daemon run [--data-dir d] [--config p]
 * [--socket s]`. This is what the rendered launchd plist / systemd unit
 * executes; it runs until SIGTERM/SIGINT and then shuts down cleanly
 * (children survive — the next boot re-adopts them).
 */
import { isTestDaemonEnv, refuseNonLoopbackFetch } from "./testNetworkGuard.ts";
import { existsSync } from "node:fs";
import { measureDirectoryBytes } from "../../driver-cell/src/index.ts";
import { parseDaemonRunArgs, resolveDaemonDataDir, loadDaemonConfig } from "./daemonConfig.ts";
export { parseDaemonRunArgs, resolveDaemonConfig, type DaemonRunArgs } from "./daemonConfig.ts";
import { HiveDaemon } from "./daemon.ts";

const SCHEDULING_RECHECK_MS = 60_000;

/** Test daemons: a volume of `totalBytes` whose only occupant is the Cells root. */
function simulatedCellVolume(cellsRoot: string, totalBytes: number): (path: string) => { totalBytes: number; freeBytes: number } {
  return () => ({ totalBytes, freeBytes: Math.max(0, totalBytes - (existsSync(cellsRoot) ? measureDirectoryBytes(cellsRoot) : 0)) });
}

/** Run the daemon in the foreground until a termination signal. */
export async function runDaemon(argv: string[]): Promise<number> {
  if (isTestDaemonEnv()) refuseNonLoopbackFetch((op) => process.stderr.write(`${op}\n`));
  const args = parseDaemonRunArgs(argv);
  const dataDir = resolveDaemonDataDir(args);
  const held = validateDaemonNode(dataDir, true);
  if (held) { process.stderr.write(`hived held, needs repair: ${held}\n`); return 0; }
  const cfg = loadDaemonConfig(args, dataDir);
  // Test daemons shorten the delay before the first automatic Cell retention pass.
  const retentionDelay = Number(process.env.HIVE_TEST_RETENTION_INITIAL_DELAY_MS);
  const diskCheckMs = Number(process.env.HIVE_TEST_CELL_DISK_CHECK_MS);
  const volumeBytes = Number(process.env.HIVE_TEST_CELL_VOLUME_BYTES);
  const pressureRetryMs = Number(process.env.HIVE_TEST_CELL_PRESSURE_RETRY_MS);
  const transcriptSweepDelayMs = Number(process.env.HIVE_TEST_TRANSCRIPT_SWEEP_DELAY_MS);
  const championHomeMinIntervalMs = Number(process.env.HIVE_TEST_CHAMPION_HOME_MIN_INTERVAL_MS);
  const resumeBundleMinIntervalMs = Number(process.env.HIVE_TEST_RESUME_BUNDLE_MIN_INTERVAL_MS);
  const championStaleHomeRetentionMs = Number(process.env.HIVE_TEST_CHAMPION_STALE_HOME_RETENTION_MS);
  const daemon = new HiveDaemon(cfg, {
    ...(Number.isFinite(retentionDelay) && retentionDelay >= 0 ? { retentionInitialDelayMs: retentionDelay } : {}),
    ...(Number.isFinite(diskCheckMs) && diskCheckMs > 0 ? { retentionDiskCheckMs: diskCheckMs } : {}),
    ...(Number.isFinite(pressureRetryMs) && pressureRetryMs > 0 ? { retentionPressureRetryMs: pressureRetryMs } : {}),
    ...(Number.isFinite(transcriptSweepDelayMs) && transcriptSweepDelayMs >= 0 ? { transcriptSweepDelayMs } : {}),
    ...(Number.isFinite(championHomeMinIntervalMs) && championHomeMinIntervalMs >= 0 ? { championHomeMinIntervalMs } : {}),
    ...(Number.isFinite(resumeBundleMinIntervalMs) && resumeBundleMinIntervalMs >= 0 ? { resumeBundleMinIntervalMs } : {}),
    ...(Number.isFinite(championStaleHomeRetentionMs) && championStaleHomeRetentionMs >= 0 ? { championStaleHomeRetentionMs } : {}),
    ...(Number.isFinite(volumeBytes) && volumeBytes > 0 ? { retentionStatfs: simulatedCellVolume(cfg.cellsRoot, volumeBytes) } : {}),
  });
  // Test daemons deliberately own disposable stub runtimes. Production omits
  // this test-only flag so deploy/restart continues to preserve live bees.
  const reapTestRuntimes = process.env.HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN === "1";
  const scheduling = new ForegroundScheduling();
  process.stdout.write(`hived scheduling: ${scheduling.describe()}\n`);
  const recheck = setInterval(() => {
    const line = scheduling.check();
    if (line) process.stdout.write(`hived scheduling: ${line}\n`);
  }, SCHEDULING_RECHECK_MS);
  recheck.unref();
  daemon.scheduling = () => scheduling.current();
  await daemon.start();
  process.stdout.write(`hived v2 listening on ${daemon.cfg.socketPath} (store ${cfg.storePath})\n`);
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
