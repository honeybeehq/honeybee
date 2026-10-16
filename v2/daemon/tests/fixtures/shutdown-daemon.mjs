import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HiveDaemon } from "../../src/daemon.ts";
import { loadNodeConfig } from "../../src/config.ts";
import { runDaemon } from "../../src/main.ts";
import { spawn } from "node:child_process";

const [dir, mode] = process.argv.slice(2);
process.env.HIVE_NODE_PATH = process.execPath;
if (mode === "retention") {
  const worker = new URL(`data:text/javascript,${encodeURIComponent(`import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(join(dir, "worker-held"))}, "held");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`)}`);
  const daemon = new HiveDaemon(loadNodeConfig(dir), { retentionWorkerUrl: worker, retentionInitialDelayMs: 0 });
  await daemon.start();
  process.once("SIGTERM", async () => {
    await daemon.shutdown();
    writeFileSync(join(dir, "shutdown-resources.json"), JSON.stringify(process.getActiveResourcesInfo()));
  });
} else {
  if (mode === "backstop") {
    const helper = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60000)"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(join(dir, "slow-helper.pid"), String(helper.pid));
  }
  process.exitCode = await runDaemon(["--data-dir", dir]);
}
