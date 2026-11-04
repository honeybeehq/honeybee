import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

export type PeercredProvenance = {
  repository: "honeybeehq/honeybee";
  workflow: ".github/workflows/ci.yml";
  event: "push";
  branch: "main";
  sourceHead: string;
  runId: number;
  jobId: number;
  artifactId: number;
  artifactSha256: string;
  binarySha256: string;
  target: string;
};

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export type GitHubRead = (endpoint: string) => Promise<unknown>;
const githubRead: GitHubRead = async endpoint => JSON.parse((await promisify(execFile)("gh", ["api", endpoint], { maxBuffer: 4 * 1024 ** 2 })).stdout);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("peercred provenance: invalid API object");
  return value as Record<string, unknown>;
}

/** Read only the three fixed files, never extract an archive into the filesystem. */
function bridgeZip(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > 16 * 1024 ** 2) throw new Error("peercred artifact is too large");
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || end + 22 > bytes.length || bytes.readUInt32LE(end) !== 0x06054b50
    || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== 3 || bytes.readUInt16LE(end + 10) !== 3
    || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) throw new Error("peercred artifact is not a three-file ZIP32");
  let offset = bytes.readUInt32LE(end + 16);
  if (offset + bytes.readUInt32LE(end + 12) !== end) throw new Error("invalid artifact directory");
  const files = new Map<string, Buffer>();
  for (let index = 0; index < 3; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid artifact entry");
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString("utf8");
    if (!["manifest.json", "peercred.node", "proof.json"].includes(name) || files.has(name)
      || flags & 1 || ![0, 8].includes(method) || size > 4 * 1024 ** 2 || compressed > 8 * 1024 ** 2
      || local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("unsupported artifact entry");
    const localLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localLength + localExtra;
    if (bytes.subarray(local + 30, local + 30 + localLength).toString("utf8") !== name || start + compressed > offset) throw new Error("invalid local artifact entry");
    const packed = bytes.subarray(start, start + compressed);
    const content = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: 4 * 1024 ** 2 });
    if (content.length !== size) throw new Error("invalid artifact size");
    files.set(name, content);
    offset += 46 + length + extra + comment;
  }
  if (offset !== end) throw new Error("invalid artifact directory size");
  return files;
}

/** Credentialed reads happen only at repack time. Tests inject API fixtures. */
export async function verifyPeercredCi(input: { sourceHead: string; target: string; ciRun: number; ciJob: number; artifactId: number; archive: string }, api: GitHubRead = githubRead) {
  if (!/^[a-f0-9]{40}$/.test(input.sourceHead) || !["linux-x64", "linux-arm64", "darwin-arm64"].includes(input.target)
    || ![input.ciRun, input.ciJob, input.artifactId].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid peercred CI request");
  const prefix = "repos/honeybeehq/honeybee/actions";
  const run = object(await api(`${prefix}/runs/${input.ciRun}`));
  const job = object(await api(`${prefix}/jobs/${input.ciJob}`));
  const artifact = object(await api(`${prefix}/artifacts/${input.artifactId}`));
  const repository = object(run.repository), owner = object(artifact.workflow_run);
  if (run.id !== input.ciRun || repository.full_name !== "honeybeehq/honeybee" || run.event !== "push"
    || run.head_branch !== "main" || run.head_sha !== input.sourceHead || ![".github/workflows/ci.yml", ".github/workflows/ci.yml@main"].includes(String(run.path))
    || run.status !== "completed" || run.conclusion !== "success"
    || job.id !== input.ciJob || job.run_id !== input.ciRun || job.status !== "completed" || job.conclusion !== "success"
    || typeof job.name !== "string" || !job.name.startsWith("peercred (") || !job.name.includes(input.target)
    || artifact.id !== input.artifactId || artifact.name !== `peercred-${input.target}` || artifact.expired !== false
    || owner.id !== input.ciRun || owner.head_sha !== input.sourceHead || owner.head_branch !== "main"
    || typeof artifact.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) throw new Error("peercred artifact has no successful pinned main push provenance");
  const archive = await readFile(input.archive);
  if (`sha256:${sha(archive)}` !== artifact.digest) throw new Error("peercred CI archive digest mismatch");
  const files = bridgeZip(archive);
  const binarySha256 = sha(files.get("peercred.node")!);
  const manifest = object(JSON.parse(files.get("manifest.json")!.toString("utf8")));
  const proof = object(JSON.parse(files.get("proof.json")!.toString("utf8")));
  if (manifest.version !== 1 || manifest.target !== input.target || manifest.napi !== 8 || manifest.sha256 !== binarySha256
    || typeof manifest.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)
    || proof.passed !== true || proof.target !== input.target || proof.sha256 !== binarySha256 || proof.sourceSha256 !== manifest.sourceSha256) throw new Error("CI bridge manifest/proof mismatch");
  const provenance: PeercredProvenance = { repository: "honeybeehq/honeybee", workflow: ".github/workflows/ci.yml", event: "push", branch: "main", sourceHead: input.sourceHead,
    runId: input.ciRun, jobId: input.ciJob, artifactId: input.artifactId, artifactSha256: sha(archive), binarySha256, target: input.target };
  return { files, provenance };
}
