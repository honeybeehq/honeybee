/** Release allocation owns only Git objects/refs; never the caller's checkout or live runtime. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertCanonicalData, canonicalDigest } from "../comb/canonical.js";
import { parseComponentIdentity } from "./index.js";

const exec = promisify(execFile);
const LEDGER = "refs/heads/honeybee-release-ledger";
const METADATA = ".release/release.json";
const ASSESSMENT = ".release/api-assessment.json";
const sha = (value: string) => /^[a-f0-9]{40}$/.test(value);
const digest = (value: unknown) => { assertCanonicalData(value); return canonicalDigest(value); };
export type ReleaseReservation = {
  schemaVersion: 1; version: string; tag: string; sourceRevision: string;
  requestedSourceRevision: string; productSourceSha256: string; assessmentSha256: string;
};
export type PrepareReleaseOptions = { repoRoot: string; sourceRevision: string; assessment: unknown; remote?: string };
function git(root: string, args: string[], env?: NodeJS.ProcessEnv) {
  return exec("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } }).then(r => r.stdout.trimEnd());
}
function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Release requires a stable semantic version");
  const parts = version.split(".").map(Number);
  if (parts.some(x => !Number.isSafeInteger(x))) throw new Error("Version exceeds safe integer range");
  return parts;
}
function assessmentBump(raw: unknown, revision: string, beforeRevision: string | null, beforeVersion?: string) {
  // Consume the canonical HON-2 classifyApiChange result, never classify here.
  const a = raw as Record<string, any>;
  if (!a || a.schemaVersion !== 1) throw new Error("Canonical API assessment required");
  const { sha256, ...body } = a;
  if (sha256 !== digest(body)) throw new Error("API assessment digest mismatch");
  const before = parseComponentIdentity(a.before), after = parseComponentIdentity(a.after);
  if (before.component !== "honeybee" || after.component !== "honeybee" || after.sourceRevision !== revision
    || (beforeRevision !== null && before.sourceRevision !== beforeRevision)
    || (beforeVersion !== undefined && before.version !== beforeVersion)) throw new Error("API assessment source/base mismatch");
  for (const side of ["before", "after"] as const) {
    const probe = a.verification?.[side];
    if (probe?.passed !== true || digest(probe.identity) !== digest(a[side]) || !Array.isArray(probe.checks)
      || !probe.checks.length || probe.checks.some((x: unknown) => typeof x !== "string" || !x.trim())
      || !/^sha256:[a-f0-9]{64}$/.test(probe.inventorySha256) || !/^sha256:[a-f0-9]{64}$/.test(probe.verifierSha256)
      || !/^sha256:[a-f0-9]{64}$/.test(a.fingerprints?.[side])) throw new Error("Verified API assessment probes required");
  }
  if (!sha(a.evaluation?.evaluatorRevision ?? "") || typeof a.evaluation?.modelRevision !== "string" || !a.evaluation.modelRevision
    || !/^sha256:[a-f0-9]{64}$/.test(a.evaluation?.promptSha256) || !/^sha256:[a-f0-9]{64}$/.test(a.evaluation?.policySha256)
    || !Array.isArray(a.checks) || a.checks.some((x: unknown) => !["compatible", "incompatible", "unverified"].includes(String(x)))) throw new Error("API assessment evaluation evidence required");
  const parts = versionParts(before.version);
  const bump = a.classification === "compatible-fix" ? "patch" : a.classification === "additive-api" ? "minor"
    : a.classification === "breaking-api" ? parts[0] === 0 ? "minor" : "major" : null;
  if (!bump || a.bump !== bump || (a.classification !== "breaking-api" && a.checks.some((x: string) => x !== "compatible"))
    || (a.classification === "breaking-api" && !a.checks.includes("incompatible"))) throw new Error("API assessment is unverified or contradicts bump policy");
  const index = { major: 0, minor: 1, patch: 2 }[bump];
  parts[index] += 1;
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
  return { version: parts.join("."), assessmentSha256: sha256 as string, before };
}

/** Conservative tracked-product digest. Only our generated metadata and root version fields are omitted. */
export async function productSourceDigest(repoRoot: string, revision: string): Promise<string> {
  if (!sha(revision)) throw new Error("Exact source revision required");
  const tree = await git(repoRoot, ["ls-tree", "-rz", "--full-tree", revision]);
  const entries = [];
  for (const entry of tree.split("\0").filter(Boolean)) {
    const [header, path] = entry.split("\t");
    if (path === METADATA || path === ASSESSMENT) continue;
    const [mode, type, object] = header.split(" ");
    if (path === "package.json" || path === "package-lock.json") {
      const pkg = JSON.parse(await git(repoRoot, ["cat-file", "blob", object]));
      delete pkg.version;
      if (path === "package-lock.json" && pkg.packages?.[""]) delete pkg.packages[""].version;
      entries.push({ path, mode, type, content: digest(pkg) });
    } else entries.push({ path, mode, type, content: object });
  }
  return digest(entries);
}

export async function prepareHoneybeeRelease(options: PrepareReleaseOptions): Promise<ReleaseReservation> {
  const { repoRoot, sourceRevision } = options, remote = options.remote ?? "origin";
  if (!sha(sourceRevision)) throw new Error("Exact source revision required");
  await git(repoRoot, ["cat-file", "-e", `${sourceRevision}^{commit}`]);
  const productSourceSha256 = await productSourceDigest(repoRoot, sourceRevision);
  const sourceRef = `refs/tags/honeybee-source-${productSourceSha256.slice(7)}`;
  const remoteRef = async (ref: string) => (await git(repoRoot, ["ls-remote", "--refs", remote, ref])).split(/\s/)[0] || null;
  const readReservation = async (commit: string): Promise<ReleaseReservation> => {
    await git(repoRoot, ["fetch", "--no-tags", remote, commit]);
    const metadata = JSON.parse(await git(repoRoot, ["show", `${commit}:${METADATA}`]));
    return { ...metadata, sourceRevision: commit };
  };
  // A CAS failure re-reads the durable winner. Distinct changes need a fresh assessment against it.
  for (let attempt = 0; attempt < 10; attempt++) {
    const existing = await remoteRef(sourceRef);
    if (existing) {
      const result = await readReservation(existing);
      if (result.productSourceSha256 !== productSourceSha256 || await productSourceDigest(repoRoot, existing) !== productSourceSha256
        || await remoteRef(`refs/tags/${result.tag}`) !== existing) throw new Error("Corrupt release reservation");
      await git(repoRoot, ["fetch", remote, `refs/tags/${result.tag}:refs/tags/${result.tag}`]);
      return result;
    }
    const previous = await remoteRef(LEDGER);
    const prior = previous ? await readReservation(previous) : null;
    const assessed = assessmentBump(options.assessment, sourceRevision, previous, prior?.version);
    if (!previous) {
      // Bootstrap still requires an exact evaluated baseline; ambiguous historical labels aren't evidence.
      await git(repoRoot, ["merge-base", "--is-ancestor", assessed.before.sourceRevision, sourceRevision]);
      const baseline = JSON.parse(await git(repoRoot, ["show", `${assessed.before.sourceRevision}:package.json`]));
      if (baseline.version !== assessed.before.version) throw new Error("Bootstrap assessment version differs from checked baseline");
    }
    const tag = `honeybee-v${assessed.version}`;
    const metadata = { schemaVersion: 1 as const, version: assessed.version, tag, requestedSourceRevision: sourceRevision,
      productSourceSha256, assessmentSha256: assessed.assessmentSha256 };
    const dir = await mkdtemp(join(tmpdir(), "honeybee-release-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(dir, "index"), GIT_AUTHOR_NAME: "Honeybee Release", GIT_AUTHOR_EMAIL: "release@honeybee.invalid",
        GIT_COMMITTER_NAME: "Honeybee Release", GIT_COMMITTER_EMAIL: "release@honeybee.invalid" };
      await git(repoRoot, ["read-tree", sourceRevision], env);
      const files: Record<string, unknown> = { [METADATA]: metadata, [ASSESSMENT]: options.assessment };
      for (const path of ["package.json", "package-lock.json"]) {
        const pkg = JSON.parse(await git(repoRoot, ["show", `${sourceRevision}:${path}`]));
        if (pkg.name !== "honeybee" || (path === "package-lock.json" && !pkg.packages?.[""])) throw new Error("Honeybee package/lock required");
        pkg.version = assessed.version;
        if (path === "package-lock.json") pkg.packages[""].version = assessed.version;
        files[path] = pkg;
      }
      const { writeFile } = await import("node:fs/promises");
      for (const [path, value] of Object.entries(files)) {
        const file = join(dir, "blob");
        await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
        const object = await git(repoRoot, ["hash-object", "-w", file]);
        await git(repoRoot, ["update-index", "--add", "--cacheinfo", "100644", object, path], env);
      }
      const tree = await git(repoRoot, ["write-tree"], env);
      const parents = ["-p", sourceRevision, ...(previous && previous !== sourceRevision ? ["-p", previous] : [])];
      const commit = await git(repoRoot, ["commit-tree", tree, ...parents, "-m", `Release Honeybee ${assessed.version}`], env);
      try {
        await git(repoRoot, ["push", "--atomic", `--force-with-lease=${LEDGER}:${previous ?? ""}`, remote,
          `${commit}:${LEDGER}`, `${commit}:refs/tags/${tag}`, `${commit}:${sourceRef}`]);
      } catch (error) {
        if (await remoteRef(LEDGER) === previous && !await remoteRef(sourceRef)) throw error;
        continue;
      }
      await git(repoRoot, ["fetch", remote, `refs/tags/${tag}:refs/tags/${tag}`]);
      return { ...metadata, sourceRevision: commit };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  throw new Error("Release allocation contention; retry against the current baseline");
}
