/**
 * Upstream mirrors: work that reached the origin's upstream but not the
 * satellite's stale origin checkout counts as landed once the Honeybee-owned
 * mirror has fetched it. The mirror is fetch-only, never writes to the origin,
 * and a Cell whose origin has no upstream keeps today's verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionCell } from "../src/provision.ts";
import { dirtyReport } from "../src/remove.ts";
import { evictCellWrapper } from "../src/retention.ts";
import { mirrorDirFor, readUpstreamMirror, refreshUpstreamMirror, UPSTREAM_REF } from "../src/upstream.ts";
import { commitInCell, fingerprintOrigin, g, makeRig } from "./helpers.ts";

function withUpstream() {
  const rig = makeRig();
  const upstream = join(rig.root, "upstream.git");
  g(rig.root, ["clone", "--quiet", "--bare", rig.origin.repo, upstream]);
  g(rig.origin.repo, ["remote", "add", "origin", upstream]);
  g(rig.origin.repo, ["fetch", "--quiet", "origin"]);
  const cell = provisionCell(
    rig.cellsRoot,
    { beeId: "bee-1", originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: "bee-1", repoName: "fixture", cellId: "c1" },
    "cmd-1",
    { disableCow: true },
  );
  const landUpstream = (source: string) => g(upstream, ["fetch", "--quiet", cell.paths.spaceDir, `+${source}:refs/heads/main`]);
  return { rig, upstream, cell, landUpstream, upstreamRoot: join(rig.root, "data", "upstream") };
}

test("upstream.ancestry: work landed upstream but missing from the stale origin is landed once the mirror fetched it", () => {
  const { rig, upstream, cell, landUpstream, upstreamRoot } = withUpstream();
  try {
    const work = commitInCell(cell.paths.spaceDir, "feature.ts", "export const f = 1;\n", "cell work");
    landUpstream("HEAD");
    const before = fingerprintOrigin(rig.origin.repo);
    assert.equal(dirtyReport(cell.paths.wrapperDir).unpushed, true, "the stale origin cannot see the landing");

    const refreshed = refreshUpstreamMirror(rig.origin.repo, upstreamRoot, { maxAgeMs: 0, timeoutMs: 30_000 });
    assert.equal(refreshed.status, "fetched");
    assert.equal(refreshed.ref?.sha, work);
    const mirror = mirrorDirFor(upstreamRoot, upstream);
    assert.equal(readFileSync(join(mirror, "objects", "info", "alternates"), "utf8").trim(), join(rig.origin.repo, ".git", "objects"));
    assert.equal(g(mirror, ["remote"]), "", "the mirror has no remote to push to");
    assert.equal(g(mirror, ["rev-parse", UPSTREAM_REF]), work);

    const report = dirtyReport(cell.paths.wrapperDir, { upstream: refreshed.ref });
    assert.equal(report.dirty, false);
    assert.equal(report.unlandedCommitCount, 0);
    assert.deepEqual(fingerprintOrigin(rig.origin.repo), before, "neither the fetch nor the probe touched the origin");

    assert.equal(refreshUpstreamMirror(rig.origin.repo, upstreamRoot, { maxAgeMs: 3_600_000, timeoutMs: 30_000 }).status, "fresh");
    assert.deepEqual(readUpstreamMirror(rig.origin.repo, upstreamRoot), refreshed.ref);
    const parked = evictCellWrapper(rig.cellsRoot, cell.paths.wrapperDir, { upstream: refreshed.ref });
    assert.ok(parked && !existsSync(cell.paths.wrapperDir), "eviction re-checks with the same mirror ref");
  } finally {
    rig.cleanup();
  }
});

test("upstream.rebased: work rebased onto the upstream under new SHAs is landed by the existing content checks against the mirror", () => {
  const { rig, upstream, cell, upstreamRoot } = withUpstream();
  try {
    const work = commitInCell(cell.paths.spaceDir, "feature.ts", "export const f = 4;\n", "cell work");
    const landing = join(rig.root, "landing");
    g(rig.root, ["clone", "--quiet", upstream, landing]);
    g(landing, ["config", "user.name", "lander"]);
    g(landing, ["config", "user.email", "lander@hive.invalid"]);
    writeFileSync(join(landing, "other.ts"), "upstream moved\n");
    g(landing, ["add", "-A"]);
    g(landing, ["commit", "-q", "-m", "unrelated upstream work"]);
    g(landing, ["fetch", "--quiet", cell.paths.spaceDir, `+${work}:refs/scratch/cell`]);
    g(landing, ["cherry-pick", work]);
    g(landing, ["push", "--quiet", "origin", "HEAD:main"]);
    const refreshed = refreshUpstreamMirror(rig.origin.repo, upstreamRoot, { maxAgeMs: 0, timeoutMs: 30_000 });
    assert.equal(refreshed.status, "fetched");
    assert.notEqual(refreshed.ref?.sha, work, "landed under a new SHA");
    assert.equal(dirtyReport(cell.paths.wrapperDir).unpushed, true);
    const report = dirtyReport(cell.paths.wrapperDir, { upstream: refreshed.ref });
    assert.equal(report.dirty, false);
    assert.equal(report.unlandedCommitCount, 0);
  } finally {
    rig.cleanup();
  }
});

test("upstream.unmerged: a pushed branch that never reached the upstream default branch stays unlanded", () => {
  const { rig, upstream, cell, upstreamRoot } = withUpstream();
  try {
    commitInCell(cell.paths.spaceDir, "feature.ts", "export const f = 2;\n", "pushed, never merged");
    g(upstream, ["fetch", "--quiet", cell.paths.spaceDir, "+HEAD:refs/heads/feature"]);
    const refreshed = refreshUpstreamMirror(rig.origin.repo, upstreamRoot, { maxAgeMs: 0, timeoutMs: 30_000 });
    assert.equal(refreshed.status, "fetched");
    assert.equal(dirtyReport(cell.paths.wrapperDir, { upstream: refreshed.ref }).unpushed, true);
  } finally {
    rig.cleanup();
  }
});

test("upstream.fallbacks: no upstream URL is unmirrored; a failing fetch keeps the last good ref", () => {
  const { rig, upstream, cell, landUpstream, upstreamRoot } = withUpstream();
  try {
    commitInCell(cell.paths.spaceDir, "feature.ts", "export const f = 3;\n", "cell work");
    landUpstream("HEAD");
    const good = refreshUpstreamMirror(rig.origin.repo, upstreamRoot, { maxAgeMs: 0, timeoutMs: 30_000 });
    assert.equal(good.status, "fetched");

    renameSync(upstream, `${upstream}.away`);
    const failed = refreshUpstreamMirror(rig.origin.repo, upstreamRoot, { maxAgeMs: 0, timeoutMs: 30_000 });
    renameSync(`${upstream}.away`, upstream);
    assert.equal(failed.status, "failed");
    assert.equal(failed.ref?.sha, good.ref!.sha, "the last good ref still counts");
    const backedOff = refreshUpstreamMirror(rig.origin.repo, upstreamRoot, { maxAgeMs: 0, timeoutMs: 30_000 });
    assert.equal(backedOff.status, "failed");
    assert.match(backedOff.status === "failed" ? backedOff.error : "", /not retried yet/, "a failed fetch is not retried at once");
    assert.equal(backedOff.ref?.sha, good.ref!.sha);

    g(rig.origin.repo, ["remote", "remove", "origin"]);
    const none = refreshUpstreamMirror(rig.origin.repo, upstreamRoot, { maxAgeMs: 0, timeoutMs: 30_000 });
    assert.equal(none.status, "unmirrored");
    assert.equal(dirtyReport(cell.paths.wrapperDir, { upstream: none.ref }).unpushed, true, "unmirrored keeps the local-refs verdict");
  } finally {
    rig.cleanup();
  }
});
