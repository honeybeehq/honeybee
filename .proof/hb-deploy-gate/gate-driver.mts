import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const repoRoot = process.env.REPO!;
const sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const { buildDeployArtifact } = await import(join(repoRoot, "v2/cli/src/deploy/command.ts"));
const workDir = await mkdtemp(join(tmpdir(), "hive-deploy-"));
const logPath = process.env.GATE_LOG!;
const log = (line: string) => appendFileSync(logPath, line + "\n");
log(`gate-driver: buildDeployArtifact sha=${sha} workDir=${workDir} tmpdir=${tmpdir()} execPath=${process.execPath} at=${new Date().toISOString()}`);
const started = Date.now();
try {
  const { artifactDir } = await buildDeployArtifact({ repoRoot, sha, workDir, log, skipTests: false, release: false });
  log(`gate-driver: PASSED artifactDir=${artifactDir} elapsedMs=${Date.now() - started}`);
} catch (error) {
  log(`gate-driver: FAILED ${error instanceof Error ? error.message : String(error)} elapsedMs=${Date.now() - started}`);
  process.exitCode = 1;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
