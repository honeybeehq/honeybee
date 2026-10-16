import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, [
  "scripts/run-v2-daemon-tests.mjs",
  "v2/daemon/tests/service.test.ts",
  "v2/daemon/tests/node-pin-entry.test.ts",
  "v2/daemon/tests/runner-host-artifact.test.ts",
  "v2/daemon/tests/update-owner.test.ts",
  "v2/cli/tests/update-service.test.ts",
], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`native deploy/restart groups failed: ${result.status ?? result.signal}`);
