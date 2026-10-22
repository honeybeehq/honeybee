import { appendFileSync, closeSync, fsyncSync, openSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeNodeRuntimeState, nodePinFile } from "./nodeRuntime.ts";
import { readBuildIdentity, type BuildIdentity } from "./release/buildIdentity.ts";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

export interface BuildPin {
  schemaVersion: 1;
  sourceRevision: string;
  target: string;
  artifactSha256?: string;
}

export interface ObservedBuild {
  sourceRevision: string | null;
  target: string;
  distHash: string | null;
  artifactSha256: string | null;
}

export class BuildPinMismatchError extends Error {
  readonly code = "build_pin_mismatch";
  readonly mismatches: string[];
  constructor(mismatches: string[]) {
    super(`build_pin_mismatch: Honeybee build pin mismatch: ${mismatches.join(", ")}`);
    this.name = "BuildPinMismatchError";
    this.mismatches = mismatches;
  }
}

export function buildPinFile(root: string): string {
  return join(root, "build-pin.json");
}

export function parseBuildPin(value: unknown): BuildPin {
  const pin = value as Partial<BuildPin> | null;
  if (!pin || pin.schemaVersion !== 1 || typeof pin.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(pin.sourceRevision)
    || typeof pin.target !== "string" || !/^(linux|darwin)-(x64|arm64)$/.test(pin.target)
    || (pin.artifactSha256 !== undefined && !/^[a-f0-9]{64}$/.test(pin.artifactSha256))) throw new Error("Invalid Honeybee build pin");
  return { schemaVersion: 1, sourceRevision: pin.sourceRevision, target: pin.target, ...(pin.artifactSha256 ? { artifactSha256: pin.artifactSha256 } : {}) };
}

export function readBuildPin(root: string): BuildPin | null {
  const value = readOptionalJson(buildPinFile(root));
  return value === null ? null : parseBuildPin(value);
}

function readOptionalJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function pinMismatches(pin: BuildPin, build: ObservedBuild | null): string[] {
  if (!build) return ["identity unavailable"];
  const mismatches: string[] = [];
  if (pin.sourceRevision !== build.sourceRevision) mismatches.push("sourceRevision");
  if (pin.target !== build.target) mismatches.push("target");
  if (pin.artifactSha256 !== undefined && pin.artifactSha256 !== build.artifactSha256) mismatches.push("artifactSha256");
  return mismatches;
}

export async function observeBuild(installation: string): Promise<ObservedBuild | null> {
  if (!existsSync(join(installation, "dist", "build-identity.json"))) return null;
  const identity = readBuildIdentity(join(installation, "dist", "build-identity.json"));
  const marker = readOptionalJson(join(installation, ".honeybee-deployment.json")) as { identity?: { artifact?: { sha256?: string } } } | null;
  return { sourceRevision: identity.sourceRevision, target: identity.target,
    distHash: await measureBuildDistHash(join(installation, "dist")),
    artifactSha256: marker?.identity?.artifact?.sha256?.replace(/^sha256:/, "") ?? null };
}

export async function captureRunningBuild(entry: string, identity: BuildIdentity): Promise<ObservedBuild> {
  let path = dirname(realpathSync(entry));
  while (dirname(path) !== path) {
    if (existsSync(join(path, "dist", "build-identity.json"))) {
      const observed = await observeBuild(path);
      if (observed?.sourceRevision === identity.sourceRevision && observed.target === identity.target) return observed;
      break;
    }
    path = dirname(path);
  }
  return { sourceRevision: identity.sourceRevision, target: identity.target, distHash: null, artifactSha256: null };
}

export function assertBuildPin(root: string, build: ObservedBuild | null, overrideReason?: string): void {
  const desired = readBuildPin(root);
  if (!desired) return;
  const mismatches = pinMismatches(desired, build);
  if (!mismatches.length) return;
  if (!overrideReason?.trim()) throw new BuildPinMismatchError(mismatches);
  if (!build) throw new BuildPinMismatchError(mismatches);
  const receipt = { schemaVersion: 1, at: new Date().toISOString(), reason: overrideReason.trim(), desired, build };
  appendBuildReceipt(root, "build-pin-overrides.jsonl", receipt);
  writeNodeRuntimeState(join(root, "build-pin-override.json"), receipt);
}

export function assertRunningBuildPin(root: string, build: ObservedBuild): void {
  const desired = readBuildPin(root);
  if (!desired) return;
  const mismatches = pinMismatches(desired, build);
  if (!mismatches.length) return;
  const receipt = readOptionalJson(join(root, "build-pin-override.json")) as { desired?: BuildPin; build?: ObservedBuild } | null;
  if (JSON.stringify(receipt?.desired) === JSON.stringify(desired) && JSON.stringify(receipt?.build) === JSON.stringify(build)) return;
  throw new BuildPinMismatchError(mismatches);
}

export async function buildReport(root: string, running: ObservedBuild | null, schemaVersion: number | null, stale = false) {
  const desired = readBuildPin(root);
  const staged = await observeBuild(join(root, "current"));
  const hostTarget = `${process.platform}-${process.arch}`;
  const drift: string[] = [];
  if (desired) {
    if (staged) drift.push(...pinMismatches(desired, staged).map(field => `staged.${field}`));
    if (running) drift.push(...pinMismatches(desired, running).map(field => `running.${field}`));
    if (desired.target !== hostTarget) drift.push("desired.hostTarget");
  }
  for (const [name, build] of [["staged", staged], ["running", running]] as const) {
    if (build && build.target !== hostTarget) drift.push(`${name}.hostTarget`);
  }
  if (staged && running && JSON.stringify(staged) !== JSON.stringify(running)) drift.push("staged.running");
  const nodePin = readOptionalJson(nodePinFile(resolve(root, "..", "v2")));
  return { desired, staged, running, hostTarget, schemaVersion, nodePin, stale, drift,
    verdict: drift.length ? "drift" : stale || !running || !staged ? "unknown" : desired ? "agrees" : "unpinned" };
}

export function changeBuildPin(root: string, pin: BuildPin | null, caller: { uid: number; pid: number; processBirth: string | null }): void {
  const desired = pin === null ? null : parseBuildPin(pin);
  const previous = readBuildPin(root);
  if (JSON.stringify(previous) === JSON.stringify(desired)) return;
  const receipt = { schemaVersion: 1, id: randomUUID(), at: new Date().toISOString(), previous, desired, caller: { transport: "local_unix", ...caller } };
  appendBuildReceipt(root, "build-pin-changes.jsonl", { ...receipt, phase: "requested" });
  writeNodeRuntimeState(buildPinFile(root), desired);
  appendBuildReceipt(root, "build-pin-changes.jsonl", { ...receipt, phase: "applied" });
}

export async function measureBuildDistHash(dist: string): Promise<string> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of (await readdir(join(dist, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path !== ".build-stamp.json" && path !== ".build-repack.json") files.push(path);
    }
  };
  await walk("");
  const hash = createHash("sha256");
  for (const path of files) hash.update(path).update("\0").update(await readFile(join(dist, path))).update("\0");
  return hash.digest("hex");
}

function appendBuildReceipt(root: string, name: string, receipt: unknown): void {
  appendFileSync(join(root, name), JSON.stringify(receipt) + "\n", { mode: 0o600, flush: true });
  const fd = openSync(root, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
