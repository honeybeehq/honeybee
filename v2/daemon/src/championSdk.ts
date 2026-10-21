import { executionBackendOf } from "../../core/src/executionBackend.ts";
import { hostname } from "node:os";
import { mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { claudeSdkAdapter } from "../../adapters/src/index.ts";
import type { BeeRow } from "../../core/src/types.ts";
import { autoswapDisabled } from "../../core/src/quota.ts";
import { assertStudio, readPolicy, runtimeEnv, sandboxProfile, LaunchRefusal } from "../../experimental/champion-harness/bridge/policy.ts";

export function championSpawn(bee: BeeRow, generation: number, policyPath: string, cliPath: string, configDir: string, sourceEnv: Record<string, string>) {
  assertStudio(process.platform, hostname(), bee.account, autoswapDisabled(bee));
  if (bee.agent !== "claude" || bee.substrate !== "hsr" || executionBackendOf(bee) !== "champion_sdk") throw new LaunchRefusal("Champion SDK requires explicit HSR backend");
  const policy = readPolicy(policyPath);
  if (realpathSync(policy.cliPath) !== realpathSync(cliPath)) throw new LaunchRefusal("SDK must use the hive Claude executable verified by the refresh proof");
  const home = join(bee.cwd, ".champion-harness");
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const env = runtimeEnv(sourceEnv, configDir, tmp);
  const source = import.meta.url.endsWith(".ts");
  const bridge = fileURLToPath(new URL(source ? "../../experimental/champion-harness/bridge/main.ts" : "./champion-bridge.js", import.meta.url));
  return {
    adapter: claudeSdkAdapter,
    command: "/usr/bin/sandbox-exec",
    args: ["-p", sandboxProfile([home, configDir, tmp]), process.execPath, ...(source ? ["--experimental-strip-types"] : []), bridge,
      "--home", home, "--bee", bee.id, "--node", hostname(), "--generation", String(generation),
      "--policy", policyPath, "--account", bee.account!, "--autoswap", "false", "--config-dir", configDir],
    cwd: bee.cwd,
    env,
  };
}
