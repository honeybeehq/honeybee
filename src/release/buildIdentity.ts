/** Build facts are not a verified release identity: no artifact URL/checksum is invented. */
import { readFileSync } from "node:fs";

export interface BuildIdentity {
  schemaVersion: 1;
  component: "honeybee" | "apiary" | "apiaryd";
  version: string;
  packageVersion: string;
  sourceRevision: string | null;
  dirty: boolean | null;
  release: boolean;
  target: string;
}

export function parseBuildIdentity(value: unknown): BuildIdentity {
  const v = value as Partial<BuildIdentity> | null;
  if (!v || v.schemaVersion !== 1 || !["honeybee", "apiary", "apiaryd"].includes(v.component ?? "")
    || typeof v.version !== "string" || !v.version || typeof v.packageVersion !== "string" || !v.packageVersion
    || !(v.sourceRevision === null || (typeof v.sourceRevision === "string" && /^[0-9a-f]{40}$/.test(v.sourceRevision)))
    || !(v.dirty === null || typeof v.dirty === "boolean") || typeof v.release !== "boolean"
    || typeof v.target !== "string" || !v.target
    || (v.release && (v.dirty !== false || v.sourceRevision === null || v.version !== v.packageVersion))) {
    throw new Error("Invalid component build identity");
  }
  return { schemaVersion: 1, component: v.component!, version: v.version, packageVersion: v.packageVersion,
    sourceRevision: v.sourceRevision, dirty: v.dirty, release: v.release, target: v.target };
}

export function readBuildIdentity(path: string | URL): BuildIdentity {
  return parseBuildIdentity(JSON.parse(readFileSync(path, "utf8")));
}

/** Resolve from this installation, never cwd or the operator's current git checkout. */
export function honeybeeBuildIdentity(): BuildIdentity {
  try {
    const identity = readBuildIdentity(new URL("../build-identity.json", import.meta.url));
    if (identity.component === "honeybee") return identity;
  } catch { /* Source execution and legacy packages have no build evidence. */ }
  let packageVersion = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    if (pkg.name === "honeybee" && typeof pkg.version === "string") packageVersion = pkg.version;
  } catch { /* No package evidence. */ }
  return { schemaVersion: 1, component: "honeybee", version: `${packageVersion}-dev.unknown`,
    packageVersion, sourceRevision: null, dirty: null, release: false, target: `${process.platform}-${process.arch}` };
}
