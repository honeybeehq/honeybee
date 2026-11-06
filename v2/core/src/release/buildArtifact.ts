import { spawn, execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { collectBuildProvenance } from "./buildIdentityProducer.ts";
import { hostGitEnv } from "../hostGit.ts";
import { HARNESS_HOME_ENV } from "../accountRecipes.ts";
import { socketPathFits } from "../socketPath.ts";
import { prepareRuntimeTarget, validateRuntimeBuildTarget } from "./runtimeTarget.ts";
import { parseNpmPackResult } from "./npmPack.ts";

const execFileAsync = promisify(execFile);

export type BuildArtifactContext = {
  repoRoot: string;
  sha: string;
  /** Disposable temp dir for the clean checkout + build; removed afterwards. */
  workDir: string;
  log: (line: string) => void;
  /** Skip the test gate (check + build still run). */
  skipTests?: boolean;
  /** Publication runs every release gate regardless of local deployment state. */
  release?: boolean;
  /** Explicit release target; omitted for native local deploy builds. */
  target?: string;
};

const HARNESS_HOME_VARIABLES = new Set(Object.values(HARNESS_HOME_ENV));
const RUNNER_HOST_SOCKET_SAMPLE = join("hc-XXXXXX", "s", `hb-rh-${"0".repeat(16)}`, "stdin.sock");

function keepsGateTestVariable(key: string): boolean {
  if (key.startsWith("HIVE_")) return key.startsWith("HIVE_TEST_");
  return !HARNESS_HOME_VARIABLES.has(key);
}

async function gateTestEnv(workDir: string): Promise<{ env: NodeJS.ProcessEnv; dispose: () => Promise<void> }> {
  const bin = join(workDir, "gate-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "security"), "#!/bin/sh\necho 'deploy gate: a test tried to run security; refused' >&2\nexit 1\n", { mode: 0o755 });
  const base = hostGitEnv();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (keepsGateTestVariable(key)) env[key] = value;
  env.HIVE_NO_KEYCHAIN = "1";
  env.PATH = `${bin}${delimiter}${base.PATH ?? ""}`;
  const temp = socketPathFits(join(tmpdir(), RUNNER_HOST_SOCKET_SAMPLE)) ? null : await realpath(await mkdtemp(join("/tmp", "hive-gate-")));
  if (temp !== null) env.TMPDIR = temp;
  return { env, dispose: async () => { if (temp !== null) await rm(temp, { recursive: true, force: true }); } };
}

/** Stream a build/restart step; the child's output is the progress report. */
async function runStep(command: string, args: string[], cwd: string, log: (line: string) => void, env: NodeJS.ProcessEnv = hostGitEnv()): Promise<void> {
  log(`deploy: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.error) throw result.error;
  if (result.code !== 0) {
    throw new Error(`deploy: '${command} ${args.join(" ")}' exited with ${result.code ?? `signal ${result.signal}`}`);
  }
}

/**
 * The production build: export the committed tree (never the developer tree),
 * install deps, run the check suite + full tests, build, then materialize the
 * exact published file set (npm pack) with production-only node_modules. The
 * returned stage directory is self-sufficient — nothing in it resolves back
 * into the repo.
 */
export async function buildDeployArtifact(
  { repoRoot, sha, workDir, log, skipTests, release, target }: BuildArtifactContext,
): Promise<{ artifactDir: string }> {
  if (release && skipTests) throw new Error("Release artifacts cannot skip tests");
  if (target !== undefined) validateRuntimeBuildTarget(target);
  const checkout = join(workDir, "checkout");
  await mkdir(checkout, { recursive: true });
  const tarPath = join(workDir, "source.tar");
  await runStep("git", ["-C", repoRoot, "archive", "--format=tar", "-o", tarPath, sha], workDir, log);
  await runStep("tar", ["-xf", tarPath, "-C", checkout], workDir, log);

  // git archive removes .git; capture facts for the exported revision, not the working tree.
  await writeFile(join(checkout, ".build-provenance.json"), JSON.stringify(collectBuildProvenance(repoRoot, sha)));
  const gate = await gateTestEnv(workDir);
  try {
    await runStep("npm", ["ci"], checkout, log, gate.env);
    await runStep("npm", ["run", "check"], checkout, log, gate.env);
    await runStep("npm", ["run", "build"], checkout, log, gate.env);
    if (skipTests === true) {
      log("deploy: WARNING test gate skipped (--skip-tests) — this artifact is not release-grade");
    } else {
      for (const script of release ? ["v2:test", "v2:daemon", "v2:driver", "v2:driver2", "v2:harness"] : ["v2:test", "v2:daemon", "v2:driver", "v2:harness"]) {
        await runStep("npm", ["run", script], checkout, log, gate.env);
      }
    }
  } finally { await gate.dispose(); }

  // npm pack gives exactly the `files` set a real install would receive; the
  // lockfile rides along so the stage can `npm ci --omit=dev` production deps.
  const packDest = join(workDir, "pack");
  await mkdir(packDest, { recursive: true });
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packDest], { cwd: checkout });
  const { filename } = parseNpmPackResult(stdout, "honeybee");
  const stage = join(workDir, "stage");
  await mkdir(stage, { recursive: true });
  await runStep("tar", ["-xzf", join(packDest, filename), "-C", stage, "--strip-components", "1"], workDir, log);
  await cp(join(checkout, "package-lock.json"), join(stage, "package-lock.json"));
  await runStep("npm", ["ci", "--omit=dev"], stage, log);
  if (target !== undefined) await prepareRuntimeTarget(stage, target);
  return { artifactDir: stage };
}

