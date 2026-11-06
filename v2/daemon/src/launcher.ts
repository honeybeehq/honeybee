import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const LAUNCHER_FILE_NAME = "launch";
export const HANDOVER_ATTEMPTS_FILE_NAME = "handover.attempts";
export const ROLLBACK_FILE_NAME = "rollback.json";
export const CRASH_LOOP_ATTEMPTS = 3;

export function launcherPath(root: string): string {
  return join(root, LAUNCHER_FILE_NAME);
}

export function renderLauncher(): string {
  return `#!/bin/sh
R=$(cd "$(dirname "$0")" && pwd); NODE=$1; shift
if [ -f "$R/handover.json" ]; then
  N=$(( $(cat "$R/handover.attempts" 2>/dev/null || echo 0) + 1 ))
  if [ "$N" -gt ${CRASH_LOOP_ATTEMPTS} ] && [ -L "$R/previous" ]; then
    C=$(readlink "$R/current"); P=$(readlink "$R/previous")
    ln -sfn "$P" "$R/current" && printf '{"reason":"crash_loop","candidate":"%s","previous":"%s","attempts":%s,"at":%s}\\n' "$C" "$P" "$((N - 1))" "$(date +%s)000" > "$R/rollback.json"
    rm -f "$R/handover.json" "$R/handover.attempts"
  else
    echo "$N" > "$R/handover.attempts"
  fi
fi
exec "$NODE" "$R/current/dist/cli.js" "$@"
`;
}

export async function installLauncher(root: string): Promise<string> {
  const path = launcherPath(root);
  const temporary = `${path}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  const handle = await open(temporary, "wx", 0o755);
  try { await handle.writeFile(renderLauncher()); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(root, "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return path;
}
