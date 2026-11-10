import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_ARTIFACT_SUMS_FILENAME,
  packRuntimeArtifact,
  parseRuntimeArtifactManifest,
  readArtifactProtocol,
} from "../../core/src/release/runtimeArtifact.ts";
import { PROTOCOL } from "../src/protocol.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA = "0123456789abcdef0123456789abcdef01234567";

function productionCliChunks(): string[] {
  return readdirSync(join(ROOT, "dist", "v2")).filter((name) => /^cli-chunk-.+\.js$/.test(name));
}

test.before(() => {
  const built = spawnSync(process.execPath, [join(ROOT, "scripts", "build-v2-artifact.mjs")], { cwd: ROOT, stdio: "inherit" });
  assert.equal(built.status, 0, `v2 artifact build failed: code=${String(built.status)} signal=${String(built.signal)}`);
});

test("the artifact protocol is read from the production v2 bundle, which is split into chunks", async () => {
  assert.ok(productionCliChunks().length > 0, "the production v2 CLI bundle is no longer chunked; this test must still run against what the build writes");
  assert.equal(await readArtifactProtocol(ROOT), PROTOCOL);
});

test("the production build output packs to the end: tarball with every chunk, manifest and checksums", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hive-runtime-artifact-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stage = join(dir, "stage");
  cpSync(join(ROOT, "dist"), join(stage, "dist"), { recursive: true });
  rmSync(join(stage, "dist", "build-identity.json"), { force: true });
  cpSync(join(ROOT, "contracts", "execution", "v1"), join(stage, "contracts", "execution", "v1"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(stage, "package.json"));

  const outDir = join(dir, "out");
  const outcome = await packRuntimeArtifact({ artifactDir: stage, sha: SHA, outDir });

  assert.equal(outcome.manifest.protocol, PROTOCOL);
  assert.deepEqual(parseRuntimeArtifactManifest(execFileSync("tar", ["-xzOf", outcome.tarballPath, "manifest.json"], { encoding: "utf8" })), outcome.manifest);
  const packed = new Set(execFileSync("tar", ["-tzf", outcome.tarballPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n"));
  for (const file of ["dist/cli.js", "dist/v2/cli.js", "dist/v2/runner-host.js", ...productionCliChunks().map((chunk) => `dist/v2/${chunk}`)]) {
    assert.ok(packed.has(file), `tarball is missing ${file}`);
  }
  execFileSync("shasum", ["-a", "256", "-c", RUNTIME_ARTIFACT_SUMS_FILENAME], { cwd: outDir, stdio: "pipe" });
});
