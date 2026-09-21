import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readBuildIdentity, type BuildIdentity } from "./release/buildIdentity.js";
import { UPDATE_RECOVERY_CONTRACT } from "./updateReservation.js";

/** Legacy-only verbs that remain reachable after the v2 freeze flip. */
const V1_VERBS_KEPT_WHEN_FROZEN = new Set(["deploy", "__complete"]);

/**
 * Keep the freeze check in a dependency-light module: the installed CLI
 * bootstrap imports this before choosing either the v2 or legacy graph.
 */
export function v2IsDefault(argv0: string | undefined): boolean {
  if (argv0 !== undefined && V1_VERBS_KEPT_WHEN_FROZEN.has(argv0)) return false;
  const root = process.env.HIVE_STORE_ROOT ?? join(homedir(), ".hive");
  return runtimeUsesV2(join(root, "runtime"));
}


/** Deployment configuration, independent of release provenance or bee lifecycle. */
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

/** Keep a verified current receipt as the upgrade path for earlier installs. */
export function runtimeUsesV2(root: string): boolean {
  return configuredV2Runtime(root) || existsSync(join(root, "..", "FROZEN")) || installedV2Runtime(root);
}

export const V2_DEPLOY_MARKER = ".honeybee-deployment.json";

/** Owner-written receipt in the immutable version. Only hive deploy writes it,
 * after checking the release checksum, build identity and recovery capability.
 * Keep routing dependency-light: no legacy graph, SQLite or schema compiler. */
export function installedV2Runtime(root: string): boolean {
  return installedV2Identity(root) !== null;
}

type InstalledV2Identity = Pick<BuildIdentity, "component" | "version" | "target"> & {
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
