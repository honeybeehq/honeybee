import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { buildDeployArtifact } from "../src/commands/deploy.js";

const exec = promisify(execFile);

test("deploy gate receives keychain-free env and keeps its Node options", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-gate-env-"));
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--no-warnings";
  try {
    const repo = join(dir, "repo"), workDir = join(dir, "work"), result = join(dir, "observed.json");
    await mkdir(repo); await mkdir(workDir);
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "gate-probe", version: "1.0.0", scripts: { check: "node probe.cjs" } }));
    await writeFile(join(repo, "package-lock.json"), JSON.stringify({ name: "gate-probe", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "gate-probe", version: "1.0.0" } } }));
    await writeFile(join(repo, "probe.cjs"), `const fs=require('node:fs');const cp=require('node:child_process');const security=cp.spawnSync('security',[],{encoding:'utf8'});fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({noKeychain:process.env.HIVE_NO_KEYCHAIN,nodeOptions:process.env.NODE_OPTIONS,path:process.env.PATH,securityStatus:security.status,securityError:security.stderr}));process.exit(17);`);
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Lab", "-c", "user.email=lab@example.invalid", "commit", "-qm", "gate probe"]]) await exec("git", args, { cwd: repo });
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repo });
    await assert.rejects(buildDeployArtifact({ repoRoot: repo, sha: stdout.trim(), workDir, log() {}, skipTests: true }), /exited with 17/);
    const observed = JSON.parse(await readFile(result, "utf8"));
    assert.equal(observed.noKeychain, "1");
    assert.equal(observed.nodeOptions, "--no-warnings");
    assert.ok(observed.path.split(process.platform === "win32" ? ";" : ":").includes(join(workDir, "gate-bin")));
    assert.equal(observed.securityStatus, 1);
    assert.match(observed.securityError, /test tried to run security; refused/);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
