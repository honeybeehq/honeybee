import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { readBuildIdentity, type BuildIdentity } from "./release/buildIdentity.ts";
import { UPDATE_RECOVERY_CONTRACT } from "./updateReservation.ts";

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

/** Owner-written receipt of a verified artifact install inside the immutable version. */
export const V2_DEPLOY_MARKER = ".honeybee-deployment.json";

export type InstalledV2Identity = Pick<BuildIdentity, "component" | "version" | "target"> & {
  sourceRevision: string; artifact: { url: string; sha256: string };
};

export function installedV2Identity(root: string): InstalledV2Identity | null {
  try {
    const revision = readlinkSync(join(root, "current"));
    if (!/^[a-f0-9]{40}$/.test(revision)) return null;
    const dir = join(root, revision);
    const marker = JSON.parse(readFileSync(join(dir, V2_DEPLOY_MARKER), "utf8"));
    const build = readBuildIdentity(join(dir, "dist", "build-identity.json"));
    const identity = marker.identity;
    const valid = marker.schemaVersion === 1 && marker.runtime === "v2" && marker.recoveryContract === UPDATE_RECOVERY_CONTRACT
      && build.release && build.dirty === false && build.component === "honeybee"
      && build.sourceRevision === revision && build.target === `${process.platform}-${process.arch}`
      && identity?.component === build.component && identity.version === build.version
      && identity.sourceRevision === build.sourceRevision && identity.target === build.target
      && typeof identity.artifact?.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(identity.artifact.sha256)
      && typeof identity.artifact?.url === "string" && new URL(identity.artifact.url).protocol === "https:";
    return valid ? identity as InstalledV2Identity : null;
  } catch { return null; }
}
