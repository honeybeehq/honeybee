import { spawnSync } from "node:child_process";
import { release } from "node:os";
const launcher = "/usr/bin/unshare";
const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
const version = spawnSync(launcher, ["--version"], { encoding: "utf8", env });
const probe = process.platform === "linux" ? spawnSync(launcher, ["--user", "--map-current-user", "--pid", "--fork", "--kill-child=SIGKILL", process.execPath, "-e", "if(process.pid!==1)process.exit(1);process.stdout.write('ready')"], { encoding: "utf8", env, timeout: 5000 }) : null;
const available = probe?.status === 0 && probe.stdout === "ready";
console.log(JSON.stringify({ available, platform: process.platform, kernel: release(), launcherVersion: version.stdout?.trim() ?? "", reason: available ? null : "secret_execution_containment_unavailable" }));
if (!available) process.exitCode = 1;
