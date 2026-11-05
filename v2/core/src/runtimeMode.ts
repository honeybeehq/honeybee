import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The one "v2 is live" signal: `<store>/runtime/runtime-mode.json`. Every
 * deploy and rollback writes it so Honeybee versions still deployed on peer
 * nodes keep routing plain `hive` into v2. Owner: hive deploy. Delete once no
 * peer runs a build that consults FROZEN or the deployment marker for routing.
 */
export const RUNTIME_MODE_CONFIG = "runtime-mode.json";

export function configuredV2Runtime(root: string): boolean {
  const file = join(root, RUNTIME_MODE_CONFIG);
  try {
    if (!lstatSync(file).isFile()) throw new Error("not a regular file");
    const config = JSON.parse(readFileSync(file, "utf8"));
    if (config?.schemaVersion !== 1 || config.runtime !== "v2" || Object.keys(config).length !== 2) throw new Error("unsupported config");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Invalid runtime mode config at ${file}`, { cause: error });
  }
}
