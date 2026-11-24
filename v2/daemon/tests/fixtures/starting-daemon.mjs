import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HiveDaemon } from "../../src/daemon.ts";
import { loadNodeConfig } from "../../src/config.ts";
import { runDaemon } from "../../src/main.ts";

const [dir, mode] = process.argv.slice(2);
process.env.HIVE_NODE_PATH = process.execPath;
if (mode === "gated") {
  const storeUpgradeGate = async (signal) => {
    writeFileSync(join(dir, "upgrade.held"), String(process.pid));
    while (!existsSync(join(dir, "upgrade.release"))) {
      signal?.throwIfAborted();
      await sleep(20);
    }
  };
  const daemon = new HiveDaemon(loadNodeConfig(dir), { storeUpgradeGate });
  let started = false;
  process.once("SIGTERM", () => {
    if (started) void daemon.shutdown();
    else daemon.abortStart?.();
  });
  try {
    await daemon.start();
    started = true;
    writeFileSync(join(dir, "daemon.ready"), String(process.pid));
  } catch (error) {
    writeFileSync(join(dir, "start.failed"), String(error?.message ?? error));
    process.exitCode = 0;
  }
} else {
  process.exitCode = await runDaemon(["--data-dir", dir]);
}
