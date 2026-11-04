#!/usr/bin/env node
// `npm run deploy`: the live runtime is ~/.hive/runtime/current, so the
// installed `hive deploy` builds this checkout's HEAD in a clean temp checkout,
// installs it as a new version, retargets current and restarts the daemon.
//
//   npm run deploy
//   npm run deploy -- --rollback
//
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = ["deploy", ...process.argv.slice(2)];
console.log(`deploy-settle: hive ${args.join(" ")}`);
const outcome = spawnSync("hive", args, { cwd: repoRoot, stdio: "inherit" });
if (outcome.error) throw outcome.error;
process.exit(outcome.status ?? 1);
