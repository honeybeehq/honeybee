import { createHash } from "node:crypto";
import { mkdir, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { readBuildIdentity } from "./release/buildIdentity.js";
import { hashDirectoryTree, readBuildStamp, REPACK_RECORD_FILENAME, verifyRepackedDist, type RepackRecord } from "./deploySettle.js";
import { verifyPeercredCi, type GitHubRead } from "./peercredProvenance.js";

/** Verify the CI archive before adding any bytes or publishing a repack record. */
export async function repackPeercred(dist: string, input: Parameters<typeof verifyPeercredCi>[0], api?: GitHubRead): Promise<RepackRecord> {
  const identity = readBuildIdentity(join(dist, "build-identity.json"));
  if (identity.sourceRevision !== input.sourceHead || identity.target !== input.target) throw new Error("repack does not match the pinned build identity");
  const stamp = await readBuildStamp(dist);
  if (!stamp || stamp.hash !== await hashDirectoryTree(dist)) throw new Error("repack base is not its stamped artifact");
  if (await lstat(join(dist, "v2", "peercred")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("repack cannot replace existing peercred files");
  const { files, provenance } = await verifyPeercredCi(input, api);
  const prefix = `v2/peercred/${input.target}`;
  const directory = join(dist, prefix);
  await mkdir(directory, { recursive: true });
  const addedFiles = [];
  for (const [name, bytes] of [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    await writeFile(join(directory, name), bytes, { flag: "wx", mode: 0o644 });
    addedFiles.push({ path: `${prefix}/${name}`, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const record: RepackRecord = { schema: 1, sourceHead: input.sourceHead, baseArtifactHash: stamp.hash,
    repackArtifactHash: await hashDirectoryTree(dist), addedFiles,
    peercred: { target: input.target, sha256: provenance.binarySha256, ciRun: input.ciRun, ciJob: input.ciJob, provenance } };
  const raw = JSON.stringify(record);
  await verifyRepackedDist(dist, stamp.hash, raw);
  await writeFile(join(dist, REPACK_RECORD_FILENAME), raw + "\n", { flag: "wx", mode: 0o644 });
  return record;
}
