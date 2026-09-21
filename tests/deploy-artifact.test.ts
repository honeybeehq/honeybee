import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployArtifact, deployVersion, currentDeployTarget } from "../src/deployRuntime.js";
import { DatabaseSync } from "node:sqlite";
import { recoverySubjectDigest, parseRecoveryPlan } from "../src/release/index.js";
import * as v2 from "../src/release/v2.js";
import { UPDATE_RECOVERY_CONTRACT, type UpdateAdmission } from "../src/updateAdmission.js";

test("artifact deploy refuses unchecked bytes before switching or restarting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-deploy-"));
  try {
    const archive = join(dir, "runtime.tgz"), root = join(dir, "runtime");
    await writeFile(archive, "corrupt");
    await assert.rejects(deployArtifact({ archive, root,
      identity: { component: "honeybee", version: "0.1.0", sourceRevision: "a".repeat(40), target: `${process.platform}-${process.arch}`,
        artifact: { url: "https://example.test/runtime.tgz", sha256: `sha256:${"0".repeat(64)}` } },
      expectedCurrent: null,
      admission: { fresh: true },
      hooks: { async restartDaemon() { assert.fail("must not restart"); } },
    }), /checksum/);
    assert.equal(await currentDeployTarget(root), null);
    assert.equal((await import("node:fs")).existsSync(join(root, RUNTIME_MODE_CONFIG)), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { cp, mkdir, readFile, readlink, symlink } from "node:fs/promises";
import { packRuntimeArtifact, sha256File } from "../src/runtimeArtifact.js";
import type { ComponentIdentity } from "../src/release/index.js";

async function release(dir: string, sha = "a".repeat(40), gate: "full" | "tests-skipped" = "full") {
  const stage = join(dir, `stage-${sha}`);
  await mkdir(join(stage, "dist", "v2"), { recursive: true });
  await writeFile(join(stage, "dist", "cli.js"), "console.log('hive');\n");
  await writeFile(join(stage, "dist", "v2", "cli.js"), `var PROTOCOL = "v2/1";\nvar UPDATE_RECOVERY_CONTRACT = "${UPDATE_RECOVERY_CONTRACT}";\nprocess.exit(1);\n`);
  await writeFile(join(stage, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1,
    component: "honeybee", version: "0.1.0", packageVersion: "0.1.0", sourceRevision: sha,
    dirty: false, release: true, target: `${process.platform}-${process.arch}` }));
  await writeFile(join(stage, "package.json"), JSON.stringify({ name: "honeybee", version: "0.1.0", engines: { node: ">=24" } }));
  await cp(join(process.cwd(), "contracts", "execution", "v1"), join(stage, "contracts", "execution", "v1"), { recursive: true });
  await symlink("cli.js", join(stage, "dist", "hive"));
  const packed = await packRuntimeArtifact({ artifactDir: stage, sha, outDir: join(dir, "out"), gate });
  const identity: ComponentIdentity = { component: "honeybee", version: "0.1.0", sourceRevision: sha,
    target: `${process.platform}-${process.arch}`, artifact: { url: "https://example.test/runtime.tgz", sha256: `sha256:${(await sha256File(packed.tarballPath)).sha256}` } };
  return { archive: packed.tarballPath, identity, stage };
}

async function reserve(dir: string, identity: ComponentIdentity): Promise<UpdateAdmission> {
  const recovery = parseRecoveryPlan(JSON.parse(await readFile(new URL("../contracts/release/v1/fixtures/recovery-plan.json", import.meta.url), "utf8")));
  recovery.subject.to.honeybee = { ...identity, component: "honeybee" };
  recovery.subject.storageRequirements = [UPDATE_RECOVERY_CONTRACT];
  recovery.subjectDigest = recoverySubjectDigest(recovery.subject);
  for (const evidence of recovery.evidence) evidence.subjectDigest = recovery.subjectDigest;
  const reservation = { epoch: 1, id: "test-update", recoverySubjectDigest: recovery.subjectDigest, active: true };
  await mkdir(join(dir, "v2"));
  const db = new DatabaseSync(join(dir, "v2", "core.sqlite3"));
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE account_credential_authorities(phase TEXT); INSERT INTO meta VALUES('schema_version','27')");
  db.prepare("INSERT INTO meta VALUES('coordinated_update',?)").run(JSON.stringify(reservation));
  db.close();
  return { reservation, recovery };
}

test("v2 recovery admits artifact deployment and rollback while preserving the foreign caller", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon16-artifact-"));
  try {
    const previous = await release(dir, "b".repeat(40)), next = await release(dir);
    const root = join(dir, "runtime");
    const activations: string[] = [];
    const hooks = { async restartDaemon() { activations.push((await currentDeployTarget(root))!); } };
    await deployArtifact({ ...previous, root, admission: { fresh: true }, expectedCurrent: null, hooks });
    const { reservation } = await reserve(dir, next.identity);
    const recovery = v2.parseRecoveryPlan(JSON.parse(await readFile(new URL("../contracts/release/v2/fixtures/remote-recovery.json", import.meta.url), "utf8")));
    recovery.subject.from.honeybee = { ...previous.identity, component: "honeybee" };
    recovery.subject.to.honeybee = { ...next.identity, component: "honeybee" };
    recovery.subject.storageRequirements = [UPDATE_RECOVERY_CONTRACT];
    recovery.subjectDigest = v2.recoverySubjectDigest(recovery.subject);
    for (const evidence of recovery.evidence) evidence.subjectDigest = recovery.subjectDigest;
    reservation.recoverySubjectDigest = recovery.subjectDigest;
    const db = new DatabaseSync(join(dir, "v2", "core.sqlite3"));
    db.prepare("UPDATE meta SET value=? WHERE key='coordinated_update'").run(JSON.stringify(reservation));
    db.close();
    const admission = { reservation, recovery };
    const caller = structuredClone(recovery.subject.from.caller);
    await deployArtifact({ ...next, root, admission, expectedCurrent: previous.identity.sourceRevision, hooks });
    await deployArtifact({ ...previous, root, admission, expectedCurrent: next.identity.sourceRevision, hooks });
    assert.deepEqual(activations, [previous.identity.sourceRevision, next.identity.sourceRevision, previous.identity.sourceRevision]);
    assert.deepEqual(recovery.subject.from.caller, caller);
    assert.deepEqual(recovery.subject.to.caller, caller);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const scenario of ["install", "identity", "gate", "fence", "conflict", "restart"] as const) {
  test(`verified artifact deploy: ${scenario}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hon8-artifact-"));
    try {
      const fixture = await release(dir, "a".repeat(40), scenario === "gate" ? "tests-skipped" : "full");
      const root = join(dir, "runtime");
      const admission = await reserve(dir, fixture.identity);
      let restarts = 0;
      const options = { ...fixture, root, admission, expectedCurrent: null as string | null,
        hooks: { async restartDaemon() { restarts++; if (scenario === "restart") throw new Error("restart failed"); } } };
      if (scenario === "identity") options.identity = { ...fixture.identity, version: "0.2.0" };
      if (scenario === "fence") options.expectedCurrent = "b".repeat(40);
      if (["identity", "gate", "fence"].includes(scenario)) {
        await assert.rejects(deployArtifact(options), /identity|gate|current runtime changed/);
        assert.equal(await currentDeployTarget(root), null);
        assert.equal((await import("node:fs")).existsSync(join(root, RUNTIME_MODE_CONFIG)), false);
        assert.equal(restarts, 0);
      } else if (scenario === "restart") {
        await assert.rejects(deployArtifact(options), /restart failed/);
        // A restart error is an uncertain activation; the owner does not silently unpublish.
        assert.equal(await currentDeployTarget(root), fixture.identity.sourceRevision);
      } else {
        await deployArtifact(options);
        assert.equal(await currentDeployTarget(root), fixture.identity.sourceRevision);
        options.expectedCurrent = fixture.identity.sourceRevision;
        if (scenario === "conflict") {
          await writeFile(join(root, fixture.identity.sourceRevision, "package.json"), "tampered");
          await assert.rejects(deployArtifact(options), /immutable version conflict/);
          assert.equal(restarts, 1);
        } else {
          await deployArtifact(options);
          assert.equal(restarts, 2);
          assert.equal(await readFile(join(root, fixture.identity.sourceRevision, "dist", "hive"), "utf8"), "console.log('hive');\n");
        }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

import { pruneRuntimeVersions, rollbackDeploy } from "../src/deployRuntime.js";
import { withFileLock } from "../src/lock.js";
import { installedV2Runtime, installedV2Identity, runtimeUsesV2, RUNTIME_MODE_CONFIG, v2IsDefault } from "../src/cliRoute.js";

test("reservation blocks ordinary rollback and pruning and retains all recovery artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-reserved-"));
  try {
    const fixture = await release(dir), root = join(dir, "runtime"), admission = await reserve(dir, fixture.identity);
    const old = "c".repeat(40);
    await mkdir(join(root, old), { recursive: true });
    await deployArtifact({ ...fixture, root, admission, expectedCurrent: null, hooks: { async restartDaemon() {} } });
    assert.ok(await readFile(join(root, fixture.identity.sourceRevision, "dist", "cli.js")));
    assert.ok((await import("node:fs")).existsSync(join(root, old)), "pending recovery files survive publication");
    await assert.rejects(rollbackDeploy({ root, hooks: { async restartDaemon() { assert.fail("restart"); } } }), /active coordinated/);
    await assert.rejects(pruneRuntimeVersions(root), /active coordinated/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("deploy queued behind reservation release cannot switch current", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-delayed-"));
  try {
    const fixture = await release(dir), root = join(dir, "runtime"), admission = await reserve(dir, fixture.identity);
    await mkdir(root);
    let deployment!: Promise<unknown>;
    await withFileLock(join(root, ".deploy.lock"), async () => {
      deployment = deployArtifact({ ...fixture, root, admission, expectedCurrent: null, hooks: { async restartDaemon() { assert.fail("restart"); } } });
      const db = new DatabaseSync(join(dir, "v2", "core.sqlite3"));
      db.prepare("UPDATE meta SET value=? WHERE key='coordinated_update'").run(JSON.stringify({ ...admission.reservation, active: false }));
      db.close();
    });
    await assert.rejects(deployment, /stale reservation/);
    assert.equal(await currentDeployTarget(root), null);
    assert.equal((await import("node:fs")).existsSync(join(root, RUNTIME_MODE_CONFIG)), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("fresh verified artifact uses v2 activation without a freeze marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-fresh-"));
  try {
    const fixture = await release(dir), root = join(dir, "runtime");
    await deployArtifact({ ...fixture, root, admission: { fresh: true }, expectedCurrent: null,
      hooks: { async restartDaemon(context) { assert.equal(context.runtime, "v2"); } } });
    assert.equal((await import("node:fs")).existsSync(join(dir, "FROZEN")), false);
    assert.equal(installedV2Runtime(root), true);
    const saved = process.env.HIVE_STORE_ROOT;
    try {
      process.env.HIVE_STORE_ROOT = dir;
      assert.equal(v2IsDefault("ls"), true);
      assert.equal(v2IsDefault(undefined), true);
      assert.equal(v2IsDefault("deploy"), false);
    } finally {
      if (saved === undefined) delete process.env.HIVE_STORE_ROOT;
      else process.env.HIVE_STORE_ROOT = saved;
    }
    await writeFile(join(root, fixture.identity.sourceRevision, "dist", "build-identity.json"), "{}");
    assert.equal(installedV2Runtime(root), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { Header } from "tar";
import { gzipSync } from "node:zlib";
import { unpackDeployArtifact } from "../src/deployArtifact.js";

for (const entry of [
  { path: "../escape", type: "File" as const },
  { path: "/escape", type: "File" as const },
  { path: "dist/link", type: "SymbolicLink" as const, linkpath: "../../escape" },
  { path: "dist/link", type: "Link" as const, linkpath: "../escape" },
  { path: "fifo", type: "FIFO" as const },
]) {
  test(`release extraction refuses unsafe ${entry.type}: ${entry.path} ${entry.linkpath ?? ""}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hon8-tar-"));
    try {
      const archive = join(dir, "unsafe.tgz"), work = join(dir, "work");
      const header = new Header({ ...entry, size: 0, mode: 0o644 });
      header.encode();
      await writeFile(archive, gzipSync(Buffer.concat([header.block!, Buffer.alloc(1024)])));
      await mkdir(work);
      const identity: ComponentIdentity = { component: "honeybee", version: "0.1.0", sourceRevision: "a".repeat(40), target: `${process.platform}-${process.arch}`,
        artifact: { url: "https://example.test/runtime.tgz", sha256: `sha256:${(await sha256File(archive)).sha256}` } };
      await assert.rejects(unpackDeployArtifact(archive, identity, work), /unsafe|absolute|path/);
      assert.equal((await import("node:fs")).existsSync(join(work, "escape")), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

for (const fresh of [false, true]) {
  test(`${fresh ? "fresh" : "reserved"} deploy resumes exact installed artifact after lost restart acknowledgement`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hon8-resume-"));
    try {
      const fixture = await release(dir), root = join(dir, "runtime");
      const admission = fresh ? { fresh: true as const } : await reserve(dir, fixture.identity);
      let restarts = 0;
      const options = { ...fixture, root, admission, expectedCurrent: null,
        hooks: { async restartDaemon() {
          restarts++;
          if (fresh && restarts === 1) await mkdir(join(dir, "v2"));
          if (restarts === 1) throw new Error("restart acknowledgement lost");
        } } };
      await assert.rejects(deployArtifact(options), /acknowledgement lost/);
      assert.equal(await currentDeployTarget(root), fixture.identity.sourceRevision);
      await deployArtifact(options);
      assert.equal(restarts, 2);
      await writeFile(join(root, fixture.identity.sourceRevision, "package.json"), "tampered");
      await assert.rejects(deployArtifact(options), /immutable|runtime changed/);
      assert.equal(restarts, 2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

for (const links of [
  [{ path: "x", linkpath: "." }, { path: "escape", linkpath: "x/.." }],
  [{ path: "dangling", linkpath: "missing" }],
  [{ path: "a", linkpath: "b" }, { path: "b", linkpath: "a" }],
]) {
  test(`release rejects unresolved or escaping symlink graph: ${links.map(l => l.path).join(",")}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hon8-link-"));
    try {
      const archive = join(dir, "links.tgz"), work = join(dir, "work");
      const blocks = links.map(link => { const header = new Header({ ...link, type: "SymbolicLink", size: 0, mode: 0o777 }); header.encode(); return header.block!; });
      await writeFile(archive, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
      await mkdir(work);
      const identity: ComponentIdentity = { component: "honeybee", version: "0.1.0", sourceRevision: "a".repeat(40), target: `${process.platform}-${process.arch}`,
        artifact: { url: "https://example.test/runtime.tgz", sha256: `sha256:${(await sha256File(archive)).sha256}` } };
      await assert.rejects(unpackDeployArtifact(archive, identity, work), /unsafe archive link|TAR_SYMLINK_ERROR/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const runFixture = promisify(execFile);

for (const receiptOnly of [false, true]) {
  test(`fresh v2 runtime mode survives source deploy and rollback (${receiptOnly ? "receipt upgrade" : "config"})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hon8-mode-"));
    const saved = process.env.HIVE_STORE_ROOT;
    try {
      const root = join(dir, "runtime"), repoRoot = join(dir, "repo");
      await mkdir(repoRoot);
      await runFixture("git", ["init", "-q", repoRoot]);
      const commit = async (value: string) => {
        await writeFile(join(repoRoot, "marker"), value);
        await runFixture("git", ["-C", repoRoot, "add", "marker"]);
        await runFixture("git", ["-C", repoRoot, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", value]);
        return (await runFixture("git", ["-C", repoRoot, "rev-parse", "HEAD"])).stdout.trim();
      };
      const initial = await commit("initial");
      const fixture = await release(dir, initial);
      const restarts: Array<string | undefined> = [];
      const hooks = {
        async restartDaemon(context: { runtime?: "v2" }) { restarts.push(context.runtime); },
        async buildArtifact({ workDir }: { workDir: string }) {
          const artifactDir = join(workDir, "stage");
          await mkdir(join(artifactDir, "dist"), { recursive: true });
          await writeFile(join(artifactDir, "dist", "cli.js"), "console.log('source');");
          return { artifactDir };
        },
      };
      await deployArtifact({ ...fixture, root, admission: { fresh: true }, expectedCurrent: null, hooks });
      assert.deepEqual(JSON.parse(await readFile(join(root, RUNTIME_MODE_CONFIG), "utf8")), { schemaVersion: 1, runtime: "v2" });
      if (receiptOnly) await rm(join(root, RUNTIME_MODE_CONFIG));
      process.env.HIVE_STORE_ROOT = dir;
      assert.equal(runtimeUsesV2(root), true);
      const firstSource = await commit("source one");
      await deployVersion({ root, repoRoot, hooks });
      assert.equal(await currentDeployTarget(root), firstSource);
      assert.equal(installedV2Identity(root), null, "runtime selection does not copy release identity");
      assert.equal(runtimeUsesV2(root), true);
      assert.equal(v2IsDefault("ls"), true);
      await commit("source two");
      await deployVersion({ root, repoRoot, hooks });
      await rollbackDeploy({ root, hooks });
      assert.equal(await currentDeployTarget(root), firstSource);
      assert.equal(installedV2Identity(root), null);
      assert.equal(v2IsDefault("ls"), true);
      assert.deepEqual(restarts, ["v2", "v2", "v2", "v2"]);
      assert.equal((await import("node:fs")).existsSync(join(dir, "FROZEN")), false);
    } finally {
      if (saved === undefined) delete process.env.HIVE_STORE_ROOT;
      else process.env.HIVE_STORE_ROOT = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("runtime mode config rejects corrupt content without routing to legacy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-mode-invalid-"));
  try {
    assert.equal(runtimeUsesV2(dir), false);
    await writeFile(join(dir, RUNTIME_MODE_CONFIG), "{}");
    assert.throws(() => runtimeUsesV2(dir), /runtime mode config/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("fresh artifact exposes its owner CLI only after restart succeeds and retries interrupted exposure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hon8-cli-install-"));
  try {
    const fixture = await release(dir), root = join(dir, "runtime"), bin = join(dir, "local", "bin");
    let restartFailed = false;
    const options = { ...fixture, root, admission: { fresh: true as const }, expectedCurrent: null,
      cliBinDirectory: bin, hooks: { async restartDaemon() { if (!restartFailed) { restartFailed = true; throw new Error("restart interrupted"); } } } };
    await assert.rejects(deployArtifact(options), /restart interrupted/);
    assert.equal((await import("node:fs")).existsSync(join(bin, "hive")), false);
    await deployArtifact(options);
    assert.equal(await readlink(join(bin, "hive")), join(root, "hive"));
    await deployArtifact(options);
    assert.equal(await readlink(join(bin, "hive")), join(root, "hive"));
    assert.match(await readFile(join(root, "hive"), "utf8"), /runtime\/current\/dist\/cli.js/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
