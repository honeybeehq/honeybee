/** The unprivileged macOS census shipped alongside the runtime. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * No PATH/env override: birth evidence used for destructive recovery must come
 * from this package's helper. Standalone remote-host bundles without a native
 * companion keep their existing ps path (and fail closed if ps is forbidden).
 * The helper's default stdout is pid ppid pgid state lstart, one row per line;
 * --identity omits state for the existing Honeybee birth parser.
 */
export function macProcessCensusPath(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  for (const relative of ["../native/process-census", "../../native/process-census", "../../dist/native/process-census"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  return undefined;
}
