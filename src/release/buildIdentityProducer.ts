/** Build-time only. The runtime consumes the resulting JSON without invoking git. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBuildIdentity, type BuildIdentity } from "./buildIdentity.js";

const releaseTagMatches = (tag: string | null, version: string): boolean => tag === `v${version}` || tag === `honeybee-v${version}`
  || /^distribution-[a-f0-9]{64}-honeybee-v(\d+\.\d+\.\d+)$/.exec(tag ?? "")?.[1] === version;

export interface BuildProvenance { sourceRevision: string | null; dirty: boolean | null; releaseTag: string | null }

export function collectBuildProvenance(root: string, revision?: string): BuildProvenance {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const sourceRevision = git("rev-parse", "--verify", `${revision ?? "HEAD"}^{commit}`);
    const dirty = revision ? false : git("status", "--porcelain", "--untracked-files=normal").length > 0;
    const tags = git("tag", "--points-at", sourceRevision).split("\n");
    const version = JSON.parse(revision ? git("show", `${sourceRevision}:package.json`) : readFileSync(join(root, "package.json"), "utf8")).version;
    return { sourceRevision, dirty, releaseTag: tags.find(t => releaseTagMatches(t, version)) ?? null };
  } catch { return { sourceRevision: null, dirty: null, releaseTag: null }; }
}

export function collectBuildIdentity(root: string): BuildIdentity {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const path = join(root, ".build-provenance.json");
  const source: BuildProvenance = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : collectBuildProvenance(root);
  const release = source.dirty === false && source.sourceRevision !== null
    && releaseTagMatches(source.releaseTag, pkg.version);
  const suffix = `${source.sourceRevision?.slice(0, 12) ?? "unknown"}${source.dirty === true ? ".dirty" : ""}`;
  return parseBuildIdentity({ schemaVersion: 1, component: "honeybee", packageVersion: pkg.version,
    version: release ? pkg.version : `${pkg.version}${pkg.version.includes("-") ? "." : "-"}dev.${suffix}`,
    sourceRevision: source.sourceRevision, dirty: source.dirty, release, target: `${process.platform}-${process.arch}` });
}
