/** Downloaded releases enter the same deploy owner as clean-checkout builds. */
import { cp, mkdir, readFile, readdir, lstat, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, posix, relative, isAbsolute, sep } from "node:path";
import { x } from "tar";
import { parseComponentIdentity, type ComponentIdentity } from "./release/index.js";
import { readBuildIdentity, parseBuildIdentity } from "./release/buildIdentity.js";
import { hashDirectoryTree } from "./deploySettle.js";
import { parseRuntimeArtifactManifest, readArtifactExecutionDigest, readArtifactProtocol, sha256File } from "./runtimeArtifact.js";

export async function unpackDeployArtifact(archive: string, expected: ComponentIdentity, workDir: string) {
  const identity = parseComponentIdentity(expected);
  if (identity.component !== "honeybee" || identity.target !== `${process.platform}-${process.arch}`) throw new Error("deploy: artifact target mismatch");
  // Snapshot the caller's file before verification and extraction (no mutable-path race).
  const snapshot = join(workDir, "release.tgz");
  await cp(archive, snapshot);
  if (`sha256:${(await sha256File(snapshot)).sha256}` !== identity.artifact.sha256) throw new Error("deploy: artifact checksum mismatch");
  const artifactDir = join(workDir, "artifact");
  await mkdir(artifactDir);
  let rejected = false, bytes = 0;
  await x({ file: snapshot, cwd: artifactDir, strict: true, preservePaths: false,
    filter(path, entry) {
      if (!("type" in entry)) return false;
      const safe = (p: string) => !posix.isAbsolute(p) && !p.split("/").includes("..") && !p.includes("\\");
      bytes += entry.size;
      const linkPath = entry.linkpath ?? "";
      const link = entry.type === "SymbolicLink" ? posix.join(posix.dirname(path), linkPath) : linkPath;
      const allowed = ["File", "Directory", "SymbolicLink", "Link"].includes(entry.type)
        && safe(path) && (!entry.linkpath || (!posix.isAbsolute(entry.linkpath) && safe(link)))
        && bytes <= 4 * 1024 ** 3;
      rejected ||= !allowed;
      return allowed;
    },
  });
  if (rejected) throw new Error("deploy: unsafe archive entry");
  // Lexical link checks alone miss chains such as x -> '.' and escape ->
  // 'x/..'. Resolve every retained link before any manifest or executable read.
  // Dangling links and cycles cannot prove containment and are refused too.
  const extractedRoot = await realpath(artifactDir);
  const validateLinks = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await validateLinks(path);
      else if (entry.isSymbolicLink()) {
        let target: string;
        try { target = await realpath(path); }
        catch { throw new Error("deploy: unsafe archive link (unresolved target)"); }
        const rel = relative(extractedRoot, target);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("deploy: unsafe archive link (outside artifact)");
      }
    }
  };
  await validateLinks(artifactDir);
  const manifest = parseRuntimeArtifactManifest(await readFile(join(artifactDir, "manifest.json"), "utf8"));
  const build = readBuildIdentity(join(artifactDir, "dist", "build-identity.json"));
  if (manifest.gate !== "full" || !build.release || build.dirty !== false
    || build.component !== identity.component || build.version !== identity.version
    || build.sourceRevision !== identity.sourceRevision || build.target !== identity.target
    || manifest.sha !== identity.sourceRevision || !manifest.identity
    || JSON.stringify(parseBuildIdentity(manifest.identity)) !== JSON.stringify(build)) throw new Error("deploy: artifact identity/gate mismatch");
  if (await hashDirectoryTree(join(artifactDir, "dist")) !== manifest.artifactHash
    || await readArtifactProtocol(artifactDir) !== manifest.protocol
    || readArtifactExecutionDigest(artifactDir) !== manifest.executionCorpusDigest) throw new Error("deploy: artifact contents mismatch");
  await readFile(join(artifactDir, "dist", "cli.js"));
  const bundle = await readFile(join(artifactDir, "dist", "v2", "cli.js"), "utf8");
  const recoveryContract = /\bUPDATE_RECOVERY_CONTRACT\d* = "([^"]+)"/.exec(bundle)?.[1] ?? null;
  return { artifactDir, artifactHash: manifest.artifactHash, identity, recoveryContract };
}

/** Includes links and modes; deploy's legacy dist-only stamp is not a release checksum. */
export async function artifactTreeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (relative: string): Promise<void> => {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = posix.join(relative, name), file = join(root, path), stat = await lstat(file);
      hash.update(JSON.stringify([path, stat.mode & 0o777, stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file"]));
      if (stat.isDirectory()) await walk(path);
      else if (stat.isSymbolicLink()) hash.update(await readlink(file));
      else hash.update(await readFile(file));
      hash.update("\0");
    }
  };
  await walk("");
  return hash.digest("hex");
}
