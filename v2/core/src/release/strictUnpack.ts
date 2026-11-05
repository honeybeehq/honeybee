import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { x } from "tar";

export const RUNTIME_ARCHIVE_MAX_BYTES = 4 * 1024 ** 3;

export class UnsafeArchiveError extends Error {
  constructor(message: string) { super(message); this.name = "UnsafeArchiveError"; }
}

export async function unpackRuntimeArchive(archive: string, destination: string): Promise<{ bytes: number }> {
  let rejected: string | null = null, bytes = 0;
  await x({ file: archive, cwd: destination, strict: true, preservePaths: false,
    filter(path, entry) {
      if (!("type" in entry)) return false;
      const safe = (p: string) => !posix.isAbsolute(p) && !p.split("/").includes("..") && !p.includes("\\");
      bytes += entry.size;
      const linkPath = entry.linkpath ?? "";
      const link = entry.type === "SymbolicLink" ? posix.join(posix.dirname(path), linkPath) : linkPath;
      const allowed = ["File", "Directory", "SymbolicLink", "Link"].includes(entry.type)
        && safe(path) && (!entry.linkpath || (!posix.isAbsolute(entry.linkpath) && safe(link)))
        && bytes <= RUNTIME_ARCHIVE_MAX_BYTES;
      if (!allowed) rejected ??= path;
      return allowed;
    },
  });
  if (rejected !== null) throw new UnsafeArchiveError(`unsafe archive entry ${rejected}`);
  await assertArtifactLinksContained(destination);
  return { bytes };
}

export async function assertArtifactLinksContained(artifactDir: string): Promise<void> {
  const extractedRoot = await realpath(artifactDir);
  const validateLinks = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await validateLinks(path);
      else if (entry.isSymbolicLink()) {
        let target: string;
        try { target = await realpath(path); }
        catch { throw new UnsafeArchiveError("unsafe archive link (unresolved target)"); }
        const rel = relative(extractedRoot, target);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new UnsafeArchiveError("unsafe archive link (outside artifact)");
      }
    }
  };
  await validateLinks(artifactDir);
}

export async function artifactTreeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (relativePath: string): Promise<void> => {
    for (const name of (await readdir(join(root, relativePath))).sort()) {
      const path = posix.join(relativePath, name), file = join(root, path), stat = await lstat(file);
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
