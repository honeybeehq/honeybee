import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertBuildPin, assertRunningBuildPin, buildPinFile, buildReport, BuildPinMismatchError, observeBuild, parseBuildPin, readBuildPin } from "../src/buildPin.ts";
import { writeNodeRuntimeState } from "../src/nodeRuntime.ts";

const revision = "a".repeat(40);
const target = `${process.platform}-${process.arch}`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hb-pin-"));
  const root = join(dir, "runtime"), stage = join(root, revision);
  await mkdir(join(stage, "dist"), { recursive: true });
  await writeFile(join(stage, "dist", "cli.js"), "fixture");
  await writeFile(join(stage, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, component: "honeybee", version: "0.1.0", packageVersion: "0.1.0", sourceRevision: revision, target, dirty: false, release: true }));
  await symlink(revision, join(root, "current"));
  const build = (await observeBuild(stage))!;
  const pin = parseBuildPin({ schemaVersion: 1, sourceRevision: revision, target });
  writeNodeRuntimeState(buildPinFile(root), pin);
  return { dir, root, stage, build, pin };
}

test("pin validation is fail closed and missing pin differs from a cleared pin", async () => {
  const f = await fixture();
  for (const invalid of [{}, { ...f.pin, sourceRevision: "main" }, { ...f.pin, artifactSha256: "bad" }, { ...f.pin, target: "windows-x64" }]) assert.throws(() => parseBuildPin(invalid));
  assert.equal(readBuildPin(join(f.dir, "missing")), null);
  writeNodeRuntimeState(buildPinFile(f.root), null);
  assert.equal(readBuildPin(f.root), null);
  await writeFile(buildPinFile(f.root), "corrupt");
  assert.throws(() => readBuildPin(f.root));
});

test("override binds the exact desired pin and observed bytes and leaves append-only evidence", async () => {
  const f = await fixture();
  assertBuildPin(f.root, f.build);
  const other = { ...f.build, sourceRevision: "b".repeat(40) };
  assert.throws(() => assertBuildPin(f.root, other), BuildPinMismatchError);
  assert.throws(() => assertRunningBuildPin(f.root, other), BuildPinMismatchError);
  assertBuildPin(f.root, other, "fixture exception");
  assertRunningBuildPin(f.root, other);
  assert.throws(() => assertRunningBuildPin(f.root, { ...other, distHash: "c".repeat(64) }), BuildPinMismatchError);
  writeNodeRuntimeState(buildPinFile(f.root), { ...f.pin, artifactSha256: "d".repeat(64) });
  assert.throws(() => assertRunningBuildPin(f.root, other), BuildPinMismatchError);
  assert.match(await readFile(join(f.root, "build-pin-overrides.jsonl"), "utf8"), /fixture exception/);
});

test("report compares running evidence independently, detects wrong host target and labels offline evidence stale", async () => {
  const f = await fixture();
  assert.equal((await buildReport(f.root, f.build, 48)).verdict, "agrees");
  assert.equal((await buildReport(f.root, null, null, true)).stale, true);
  assert.equal((await buildReport(f.root, null, null, true)).verdict, "unknown");
  const drift = await buildReport(f.root, { ...f.build, target: "darwin-arm64" }, 44);
  assert.equal(drift.schemaVersion, 44);
  assert.ok(drift.drift.includes("staged.running"));
  if (target !== "darwin-arm64") assert.ok(drift.drift.includes("running.hostTarget"));
  assert.equal(drift.verdict, "drift");
});

test("an archive checksum pin refuses source builds with no archive evidence", async () => {
  const f = await fixture();
  writeNodeRuntimeState(buildPinFile(f.root), { ...f.pin, artifactSha256: "e".repeat(64) });
  assert.throws(() => assertBuildPin(f.root, f.build), /artifactSha256/);
});

import { createServer } from "node:net";
import { setOfflineBuildPin } from "../src/buildPin.ts";

test("offline pin bootstrap serializes ownership writes and refuses a reachable daemon socket", async () => {
  const f = await fixture(), socketPath = join(f.dir, "daemon.sock");
  await setOfflineBuildPin(f.root, { ...f.pin, sourceRevision: "b".repeat(40) }, socketPath);
  assert.equal(readBuildPin(f.root)?.sourceRevision, "b".repeat(40));
  const server = createServer(socket => socket.end());
  await new Promise<void>(done => server.listen(socketPath, done));
  try {
    await assert.rejects(setOfflineBuildPin(f.root, null, socketPath), /daemon is reachable/);
    assert.equal(readBuildPin(f.root)?.sourceRevision, "b".repeat(40));
  } finally { await new Promise<void>(done => server.close(() => done())); }
  await writeFile(buildPinFile(f.root), "corrupt");
  await setOfflineBuildPin(f.root, null, socketPath);
  assert.equal(readBuildPin(f.root), null);
});
