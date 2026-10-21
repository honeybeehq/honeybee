import { parseNpmPackResult } from "../src/npmPack.js";
// Deploy settling (scripts/deploy-settle.mjs): the daemon must never restart
// over a half-copied or mid-rebuild global module tree. The settle barrier
// proves content equality between the local build and the installed tree —
// stamp AND re-hash — with bounded retries.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, rename, symlink } from "node:fs/promises";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUILD_STAMP_FILENAME,
  hashDirectoryTree,
  readBuildStamp,
  REPACK_RECORD_FILENAME,
  verifyDistAgainstArtifact,
  waitForSettledInstall,
  writeBuildStamp,
} from "../src/deploySettle.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hive-deploy-settle-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedTree(dir: string): Promise<void> {
  await mkdir(join(dir, "hsr"), { recursive: true });
  await writeFile(join(dir, "cli.js"), "console.log('hive')\n");
  await writeFile(join(dir, "hsr", "host.js"), "export const host = 1\n");
}

test("hashDirectoryTree digests path + content and ignores the stamp file", async () => {
  await withTempDir(async (root) => {
    const left = join(root, "left");
    const right = join(root, "right");
    await seedTree(left);
    await seedTree(right);
    await writeFile(join(right, BUILD_STAMP_FILENAME), '{"hash":"decoy"}\n');
    assert.equal(await hashDirectoryTree(left), await hashDirectoryTree(right), "the stamp never feeds its own digest");

    await writeFile(join(right, "hsr", "host.js"), "export const host = 2\n");
    assert.notEqual(await hashDirectoryTree(left), await hashDirectoryTree(right), "content changes the digest");

    await writeFile(join(right, "hsr", "host.js"), "export const host = 1\n");
    await writeFile(join(right, "straggler.js"), "");
    assert.notEqual(await hashDirectoryTree(left), await hashDirectoryTree(right), "an extra file changes the digest");
  });
});

test("writeBuildStamp records the tree digest and readBuildStamp tolerates garbage", async () => {
  await withTempDir(async (root) => {
    const dist = join(root, "dist");
    await seedTree(dist);
    const stamp = await writeBuildStamp(dist);
    assert.equal(stamp.hash, await hashDirectoryTree(dist), "stamping does not perturb the digest it records");
    assert.deepEqual(await readBuildStamp(dist), stamp);

    await writeFile(join(dist, BUILD_STAMP_FILENAME), '{"hash":');
    assert.equal(await readBuildStamp(dist), null, "a torn stamp reads as absent, not as an error");
    assert.equal(await readBuildStamp(join(root, "missing")), null);
  });
});

test("a settled install (stamp and tree both matching the local build) resolves first probe", async () => {
  await withTempDir(async (root) => {
    const local = join(root, "local-dist");
    await seedTree(local);
    const stamp = await writeBuildStamp(local);
    const installed = join(root, "installed-dist");
    await cp(local, installed, { recursive: true });

    const settled = await waitForSettledInstall(local, installed, { timeoutMs: 1_000, pollIntervalMs: 1 });
    assert.equal(settled.hash, stamp.hash);
    assert.equal(settled.attempts, 1);
  });
});

test("a mid-copy install settles only once the tree catches up to its stamp", async () => {
  await withTempDir(async (root) => {
    const local = join(root, "local-dist");
    await seedTree(local);
    await writeBuildStamp(local);
    // The stamp arrived but hsr/host.js has not: the exact stale-mix window
    // that false-reaped 8 live runners must NOT settle.
    const installed = join(root, "installed-dist");
    await cp(local, installed, { recursive: true });
    await rm(join(installed, "hsr", "host.js"));

    let probes = 0;
    const settled = await waitForSettledInstall(local, installed, {
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      sleep: async () => {
        probes += 1;
        // The copy completes while the settle loop is waiting.
        if (probes === 2) await cp(join(local, "hsr", "host.js"), join(installed, "hsr", "host.js"));
      },
    });
    assert.ok(settled.attempts > 1, "the incomplete tree was observed and retried");
    assert.equal(settled.hash, (await readBuildStamp(local))!.hash);
  });
});

test("an install that never settles throws after the timeout with the disagreement", async () => {
  await withTempDir(async (root) => {
    const local = join(root, "local-dist");
    await seedTree(local);
    await writeBuildStamp(local);
    // A stale worktree: complete, self-consistent, but NOT the local build.
    const installed = join(root, "installed-dist");
    await seedTree(installed);
    await writeFile(join(installed, "cli.js"), "console.log('stale hive')\n");
    await writeBuildStamp(installed);

    let clock = 0;
    await assert.rejects(
      waitForSettledInstall(local, installed, {
        timeoutMs: 50,
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
      }),
      /did not settle within 50ms.*!=/s,
    );
  });
});

const TARGET = `${process.platform}-${process.arch}`;
const SOURCE_HEAD = "b".repeat(40);
const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

async function releasedDist(dir: string): Promise<string> {
  await seedTree(dir);
  await writeFile(join(dir, "build-identity.json"), JSON.stringify({ schemaVersion: 1, component: "honeybee", version: "0.1.0",
    packageVersion: "0.1.0", sourceRevision: SOURCE_HEAD, dirty: false, release: true, target: TARGET }));
  return (await writeBuildStamp(dir)).hash;
}

async function repack(dist: string, base: string, files: Record<string, string> = {
  [`v2/peercred/${TARGET}/manifest.json`]: "{}\n",
  [`v2/peercred/${TARGET}/peercred.node`]: "native-bridge",
  [`v2/peercred/${TARGET}/proof.json`]: "{\"ok\":true}\n",
}): Promise<Record<string, unknown>> {
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(dist, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(dist, ...path.split("/")), bytes);
  }
  const record = {
    schema: 1,
    sourceHead: SOURCE_HEAD,
    baseArtifactHash: base,
    repackArtifactHash: await hashDirectoryTree(dist),
    addedFiles: Object.keys(files).sort().map((path) => ({ path, sha256: sha256(files[path]!) })),
    peercred: { target: TARGET, sha256: sha256(files[`v2/peercred/${TARGET}/peercred.node`] ?? ""), ciRun: 101, ciJob: 202,
      provenance: { repository: "honeybeehq/honeybee", workflow: ".github/workflows/ci.yml", event: "push", branch: "main", sourceHead: SOURCE_HEAD,
        runId: 101, jobId: 202, artifactId: 303, artifactSha256: "a".repeat(64), binarySha256: sha256(files[`v2/peercred/${TARGET}/peercred.node`] ?? ""), target: TARGET } },
  };
  await writeFile(join(dist, REPACK_RECORD_FILENAME), JSON.stringify(record));
  return record;
}

test("a recorded repack settles: base stamp, additions with their digests, nothing else changed", async () => {
  await withTempDir(async (root) => {
    const local = join(root, "local");
    const installed = join(root, "installed");
    const base = await releasedDist(local);
    await cp(local, installed, { recursive: true });
    const record = await repack(installed, base);
    assert.notEqual(await hashDirectoryTree(installed), base, "the additions are not excluded from the digest");
    await assert.rejects(waitForSettledInstall(local, installed, { timeoutMs: 20, pollIntervalMs: 5 }), /differs from the local one/);
    await writeFile(join(local, REPACK_RECORD_FILENAME), await readFile(join(installed, REPACK_RECORD_FILENAME)));
    const settled = await waitForSettledInstall(local, installed, { timeoutMs: 1_000, pollIntervalMs: 1 });
    assert.deepEqual(settled, { hash: record.repackArtifactHash, attempts: 1, repacked: true });
    assert.deepEqual(await verifyDistAgainstArtifact(installed, base), { hash: record.repackArtifactHash, repacked: true });
    assert.equal(await hashDirectoryTree(local), base, "a dist without a record hashes exactly as before");
  });
});

test("a repack that changed anything beyond its recorded additions never settles", async () => {
  const cases: Array<[string, (dist: string, record: Record<string, any>) => Promise<void>, RegExp]> = [
    ["tampered bridge", async (dist) => writeFile(join(dist, "v2", "peercred", TARGET, "peercred.node"), "evil"), /peercred\.node does not match its sha256/],
    ["unrecorded extra file", async (dist) => writeFile(join(dist, "v2", "peercred", TARGET, "extra.node"), "x"), /repacked tree .* is not the recorded/],
    ["edited base file, record re-hashed", async (dist, record) => {
      await writeFile(join(dist, "cli.js"), "console.log('tampered')\n");
      record.repackArtifactHash = await hashDirectoryTree(dist);
      await writeFile(join(dist, REPACK_RECORD_FILENAME), JSON.stringify(record));
    }, /minus its additions .* is not the base/],
    ["record names another base", async (dist, record) => {
      record.baseArtifactHash = "c".repeat(64);
      await writeFile(join(dist, REPACK_RECORD_FILENAME), JSON.stringify(record));
    }, /repack base cccccccccccc is not the expected artifact/],
    ["addition outside the bridge dir", async (dist, record) => {
      await writeFile(join(dist, "hsr", "evil.js"), "x");
      record.addedFiles = [{ path: "hsr/evil.js", sha256: sha256("x") }, ...record.addedFiles];
      record.repackArtifactHash = await hashDirectoryTree(dist);
      await writeFile(join(dist, REPACK_RECORD_FILENAME), JSON.stringify(record));
    }, /outside v2\/peercred\//],
    ["symlink in the bridge dir", async (dist) => symlink("../../../cli.js", join(dist, "v2", "peercred", TARGET, "link.js")), /symlink under v2\/peercred/],
    ["symlink at the peercred root", async (dist, record) => {
      await rename(join(dist, "v2", "peercred"), join(dist, "bridge-outside"));
      await symlink("../bridge-outside", join(dist, "v2", "peercred"));
      record.repackArtifactHash = await hashDirectoryTree(dist);
      await writeFile(join(dist, REPACK_RECORD_FILENAME), JSON.stringify(record));
    }, /requires a real directory at v2\/peercred/],
    ["bridge for another target", async (dist, record) => {
      record.peercred.target = "plan9-mips";
      await writeFile(join(dist, REPACK_RECORD_FILENAME), JSON.stringify(record));
    }, /is not this host's/],
    ["unknown record key", async (dist, record) => {
      await writeFile(join(dist, REPACK_RECORD_FILENAME), JSON.stringify({ ...record, excluded: ["v2/peercred"] }));
    }, /keys are not exactly/],
  ];
  for (const [name, mutate, reason] of cases) {
    await withTempDir(async (root) => {
      const local = join(root, "local");
      const installed = join(root, "installed");
      const base = await releasedDist(local);
      await cp(local, installed, { recursive: true });
      const record = await repack(installed, base);
      await mutate(installed, record);
      await writeFile(join(local, REPACK_RECORD_FILENAME), await readFile(join(installed, REPACK_RECORD_FILENAME)));
      await assert.rejects(
        waitForSettledInstall(local, installed, { timeoutMs: 20, pollIntervalMs: 5 }),
        (error: unknown) => error instanceof Error && /did not settle/.test(error.message) && reason.test(error.message),
        name,
      );
      await assert.rejects(verifyDistAgainstArtifact(installed, base), reason, `${name} (artifact deploy)`);
    });
  }
});

test("a local repack record must be byte-identical to the installed one", async () => {
  await withTempDir(async (root) => {
    const local = join(root, "local");
    const installed = join(root, "installed");
    const base = await releasedDist(local);
    await cp(local, installed, { recursive: true });
    const record = await repack(installed, base);
    await writeFile(join(local, REPACK_RECORD_FILENAME), JSON.stringify({ ...record, peercred: { ...(record.peercred as object), ciRun: 999 } }));
    await assert.rejects(waitForSettledInstall(local, installed, { timeoutMs: 20, pollIntervalMs: 5 }), /differs from the local one/);
  });
});

test("the tree digest preserves historical host-locale ordering for rollback", async () => {
  await withTempDir(async (root) => {
    for (const name of ["aa.js", "ab.js", "z.js", "Ab.js", "\u00e6.js", "I.js", "\u0131.js"]) await writeFile(join(root, name), name);
    const moduleUrl = new URL("../src/deploySettle.js", import.meta.url).href;
    const script = `const { hashDirectoryTree } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(await hashDirectoryTree(${JSON.stringify(root)}));`;
    const digests = new Set(["en_US.UTF-8", "nb_NO.UTF-8", "da_DK.UTF-8", "tr_TR.UTF-8"].map((locale) =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, LANG: locale, LC_ALL: locale } })));
    assert.ok(digests.size > 1, `digests per locale: ${[...digests].join(", ")}`);
    assert.ok(digests.has(await hashDirectoryTree(root)));
  });
});

test("settling without a local stamp is a caller error, not a wait", async () => {
  await withTempDir(async (root) => {
    const local = join(root, "local-dist");
    await seedTree(local);
    await assert.rejects(
      waitForSettledInstall(local, join(root, "installed"), { timeoutMs: 10 }),
      /no build stamp/,
    );
  });
});

test("deploy orchestrator rebinds launchd to the verified installed CLI before restart", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "deploy-settle.mjs"), "utf8");
  assert.match(source, /const installedCli = join\(installedDist, "cli\.js"\)/);
  assert.match(source, /\[installedCli, "daemon", "install", "--force"\]/);
  assert.match(source, /\[installedCli, "daemon", "restart"\]/);
  assert.doesNotMatch(source, /run\("hive", \["daemon", "restart"\]\)/);
});

test("frozen node hands npm deploy off to hive deploy before any global install", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "deploy-settle.mjs"), "utf8");
  assert.match(source, /existsSync\(join\(hiveStoreRoot\(\), "FROZEN"\)\)/);
  assert.match(source, /run\("hive", \["deploy", \.\.\.extra\]\)/);
  assert.ok(
    source.indexOf('run("hive", ["deploy"') < source.indexOf('run("npm", ["run", "build"])'),
    "frozen handoff must precede the local build / npm i -g path",
  );
  assert.ok(
    source.indexOf('run("hive", ["deploy"') < source.indexOf('[installedCli, "daemon", "restart"]'),
    "frozen handoff must never reach the v1 daemon-restart step",
  );

  await withTempDir(async (dir) => {
    await writeFile(join(dir, "FROZEN"), "{}\n");
    const bin = join(dir, "bin");
    await mkdir(bin);
    const hive = join(bin, "hive");
    await writeFile(hive, "#!/bin/sh\necho hive-stub \"$@\"\n");
    await chmod(hive, 0o755);
    const output = execFileSync(process.execPath, [join(process.cwd(), "scripts", "deploy-settle.mjs"), "--list"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HIVE_STORE_ROOT: dir, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.match(output, /handing off to hive deploy/);
    assert.match(output, /hive deploy --list/);
    assert.match(output, /hive-stub deploy --list/);
    assert.doesNotMatch(output, /npm run build/);
    assert.doesNotMatch(output, /npm i -g/);
  });
});

test("deploy installs an immutable package archive, never a worktree symlink", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "deploy-settle.mjs"), "utf8");
  assert.match(source, /\["pack", "--json", "--pack-destination", packRoot\]/);
  assert.match(source, /run\("npm", \["i", "-g", join\(packRoot, filename\)\]\)/);
  assert.doesNotMatch(source, /run\("npm", \["i", "-g", "\."\]\)/);
  assert.match(source, /installedPackageRoot === realpathSync\(repoRoot\)/);
  assert.ok(
    source.indexOf("writeBuildStamp(localDist)") < source.indexOf('["pack", "--json"'),
    "the packed archive must contain the certified build stamp",
  );
});

test("the deploy archive allowlist excludes workstation state and retains runtime assets", () => {
  const packed = parseNpmPackResult(execFileSync(
    "npm",
    ["pack", "--dry-run", "--json"],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ), "honeybee");
  const paths = new Set(packed.files.map((entry) => entry.path));

  for (const required of [
    "package.json",
    "dist/cli.js",
    "dist/cli-legacy.js",
    "dist/v2/cli.js",
    "dist/v2/provision-worker.js",
    "dist/v2/runner-host.js",
    "dist/hsr/runner-entry.js",
    "dist/hsr/artifacts/runner-host.mjs",
    "dist/hsr/artifacts/runner-host.manifest.json",
    "dist/execution/service.js",
    "contracts/execution/v1/profile.json",
    "docs/honeybee.tmux.conf",
  ]) {
    assert.ok(paths.has(required), `deploy archive is missing ${required}`);
  }
  for (const path of paths) {
    assert.doesNotMatch(path, /(^|\/)\.(?:local|claude|git)(?:\/|$)/, `deploy archive leaked local dot-state: ${path}`);
    assert.doesNotMatch(path, /(^|\/)(?:tests?|src|\.test-dist)(?:\/|$)/, `deploy archive leaked a development tree: ${path}`);
    assert.doesNotMatch(path, /(?:device-id|credentials?|auth\.json|settings\.local\.json)$/i, `deploy archive leaked a credential-shaped path: ${path}`);
  }
});

test("deploy preflight certifies candidate corpus bytes before the global install mutates", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "deploy-settle.mjs"), "utf8");
  assert.match(source, /computeExecutionValidationSurfaceDigest\(executionContract\)/);
  assert.match(source, /executionBaselineFeatures\(executionContract\)/);
  assert.match(source, /\["status", "--porcelain=v1", "--untracked-files=all", "--", contractCorpusPath\]/);
  assert.match(source, /\["log", "-1", "--format=%H", "--", contractCorpusPath\]/);
  assert.doesNotMatch(source, /APIARY_EXECUTION_CONTRACT_CONSUMER/);
  assert.match(source, /process\.env\.APIARY_APP_BUNDLE !== undefined/);
  assert.match(source, /loadExecutionContract\(\s*join\(installedPackageRoot, "contracts", "execution", "v1"\)/);
  assert.match(source, /assertExecutionMaterializationMatches\(\s*executionCandidate/);
  assert.match(source, /schemaDigest: installedExecutionDigest/);
  assert.match(source, /validationSurfaceDigest: installedExecutionSurface/);
  assert.ok(
    source.indexOf("preflightInstalledExecutionConsumer(executionCandidate") <
      source.indexOf('["pack", "--json", "--pack-destination", packRoot]'),
    "consumer preflight must finish before npm mutates the installed Honeybee tree",
  );
  assert.ok(
    source.indexOf("installed execution corpus verified") <
      source.indexOf('[installedCli, "daemon", "restart"]'),
    "installed contract bytes must be verified before daemon restart",
  );
});
