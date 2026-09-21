#!/usr/bin/env node
// Production adapter only. Tests exercise allocation against bare Git and publication against an asset-store boundary.
import { selectedDistribution } from "./release-distribution.mjs";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDigest } from "../src/comb/canonical.ts";
import { buildDeployArtifact } from "../src/commands/deploy.ts";
import { packRuntimeArtifact } from "../src/runtimeArtifact.ts";
import { prepareHoneybeeRelease } from "../src/release/prepare.ts";
import { publishHoneybeeRelease } from "../src/release/publish.ts";
import { GitHubReleaseStore, notifyHoneybeeRelease } from "../src/release/github.ts";

// Actions concurrency is repository-scoped, including for reusable workflow callers.
if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "honeybeehq/honeybee") {
  throw new Error("Dispatch release.yml in honeybeehq/honeybee to hold the distribution writer lock");
}
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const profile = selectedDistribution(repoRoot);
const sourceRevision = process.env.HONEYBEE_SOURCE_REVISION;
const target = process.env.HONEYBEE_TARGET;
if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "")) throw new Error("HONEYBEE_SOURCE_REVISION must be a full commit SHA");
if (!["darwin-arm64", "linux-x64"].includes(target) || target !== `${process.platform}-${process.arch}`) throw new Error("Release must build natively for the requested supported target");
const assessment = JSON.parse(process.env.HONEYBEE_API_ASSESSMENT ?? "null");
const reservation = await prepareHoneybeeRelease({ repoRoot, sourceRevision, assessment, profile });
// Reused releases retain their original assessment; callers cannot replace it on a retry.
const accepted = JSON.parse(execFileSync("git", ["-C", repoRoot, "show", `${reservation.sourceRevision}:.release/api-assessment.json`], { encoding: "utf8" }));
const { sha256, ...body } = accepted;
if (sha256 !== reservation.assessmentSha256 || sha256 !== canonicalDigest(body)) throw new Error("Reserved assessment digest mismatch");
const store = new GitHubReleaseStore(`honeybee-v${reservation.version}-${target}`, process.env.DISTRIBUTION_TOKEN ?? "", undefined, profile);
await store.open();
const result = await publishHoneybeeRelease({ reservation, profile, target, providerFingerprint: accepted.fingerprints.after, store,
  build: async () => {
    const workDir = await mkdtemp(join(tmpdir(), "honeybee-release-build-"));
    try {
      const { artifactDir } = await buildDeployArtifact({ repoRoot, sha: reservation.sourceRevision, workDir, release: true, log: console.log });
      const checkout = join(workDir, "checkout");
      const inventory = execFileSync(process.execPath, [join(checkout, "contracts/release/v1/tools/extract-inventory.mjs"), checkout], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
      await writeFile(join(artifactDir, "release-inventory.json"), inventory);
      const packed = await packRuntimeArtifact({ artifactDir, sha: reservation.sourceRevision, outDir: join(workDir, "output"), gate: "full", log: console.log });
      return new Uint8Array(await readFile(packed.tarballPath));
    } finally { await rm(workDir, { recursive: true, force: true }); }
  },
  notify: event => notifyHoneybeeRelease(event, process.env.EVALUATOR_NOTIFICATION_TOKEN ?? "", undefined, profile),
});
const receipt = { ...result, reservation };
if (process.env.HONEYBEE_RECEIPT_PATH) await writeFile(process.env.HONEYBEE_RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `descriptor-url=${result.descriptorReference.url}\ndescriptor-sha256=${result.descriptorReference.sha256}\nversion=${reservation.version}\nsource-revision=${reservation.sourceRevision}\nnotification=${result.notification}\n`);
console.log(JSON.stringify(receipt, null, 2));
if (result.notification === "pending") console.warn("::warning::Honeybee release is published; evaluator notification pending. Rerun this exact request to retry the durable release.json event.");
