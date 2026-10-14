/**
 * Upstream mirrors: work that reached the origin's upstream but not the
 * satellite's stale origin checkout counts as landed once the Honeybee-owned
 * mirror has fetched it. The mirror is fetch-only, never writes to the origin,
 * and a Cell whose origin has no upstream keeps today's verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionCell, reserveCell, type ProvisionRequest } from "../src/provision.ts";
import { dirtyReport } from "../src/remove.ts";
import { evictCellWrapper } from "../src/retention.ts";
import { buildPoolMember, claimFromPool } from "../src/warmPool.ts";
import { mirrorDirFor, readUpstreamMirror, refreshUpstreamMirror, resolveCellBase, syncOriginFromMirror, UPSTREAM_REF } from "../src/upstream.ts";
import { commitInCell, commitOn, fingerprintOrigin, g, makeOrigin, makeRig } from "./helpers.ts";

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
    assert.equal(realpathSync(readFileSync(join(mirror, "objects", "info", "alternates"), "utf8").trim()), realpathSync(join(rig.origin.repo, ".git", "objects")));
    assert.equal(statSync(upstreamRoot).mode & 0o777, 0o700, "the mirror root is private to the daemon user");
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

const OPTS = { disableCow: true, useGitImages: false } as const;

function staleSatelliteOrigin() {
  const root = mkdtempSync(join(tmpdir(), "upstream-"));
  const author = makeOrigin(root, "author");
  const github = join(root, "github.git");
  g(root, ["clone", "--bare", "--quiet", author.repo, github]);
  const origin = join(root, "material");
  g(root, ["clone", "--quiet", github, origin]);
  const stale = g(origin, ["rev-parse", "HEAD"]);
  g(author.repo, ["remote", "add", "github", github]);
  const fresh = commitOn(author.repo, "src/app.ts", "export const version = 2;\n", "landed on main");
  g(author.repo, ["push", "--quiet", "github", "main"]);
  const upstreamRoot = join(root, "data", "upstream");
  const sync = () => syncOriginFromMirror(origin, upstreamRoot, { maxAgeMs: 0, timeoutMs: 30_000 });
  return { root, author: author.repo, github, origin, stale, fresh, upstreamRoot, sync, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function request(originRepo: string, beeId: string, sha: string, cellId: string): ProvisionRequest {
  return { beeId, originRepo, sha, wrapper: `w-${beeId}`, repoName: "material", cellId };
}

test("resolveCellBase: HEAD until a fetch moves the upstream tip ahead, then the tip", () => {
  const fx = staleSatelliteOrigin();
  try {
    assert.deepEqual(
      { sha: resolveCellBase(fx.origin)?.sha, source: resolveCellBase(fx.origin)?.source },
      { sha: fx.stale, source: "head" },
    );
    const synced = fx.sync();
    assert.equal(synced.refresh.status, "fetched");
    assert.equal(synced.trackingRef, "refs/remotes/origin/main");
    assert.equal(synced.before, fx.stale);
    assert.equal(synced.after, fx.fresh);
    assert.equal(g(mirrorDirFor(fx.upstreamRoot, fx.github), ["rev-parse", UPSTREAM_REF]), fx.fresh);
    const base = resolveCellBase(fx.origin);
    assert.equal(base?.sha, fx.fresh);
    assert.equal(base?.source, "upstream");
    assert.equal(base?.upstreamRef, "refs/remotes/origin/main");
    assert.equal(typeof base?.fetchedAt, "number");
    assert.equal(g(fx.origin, ["rev-parse", "HEAD"]), fx.stale);
  } finally {
    fx.cleanup();
  }
});

test("resolveCellBase: local commits not on the upstream keep HEAD", () => {
  const fx = staleSatelliteOrigin();
  try {
    fx.sync();
    const local = commitOn(fx.origin, "README.md", "# local\n", "unpushed");
    const base = resolveCellBase(fx.origin);
    assert.equal(base?.sha, local);
    assert.equal(base?.source, "head");
    assert.equal(base?.upstreamSha, fx.fresh);
  } finally {
    fx.cleanup();
  }
});

test("resolveCellBase: no upstream configured is plain HEAD", () => {
  const root = mkdtempSync(join(tmpdir(), "upstream-"));
  try {
    const origin = makeOrigin(root);
    assert.deepEqual(resolveCellBase(origin.repo), { sha: origin.sha, source: "head" });
    const synced = syncOriginFromMirror(origin.repo, join(root, "data", "upstream"), { maxAgeMs: 0, timeoutMs: 30_000 });
    assert.equal(synced.refresh.status, "unmirrored");
    assert.equal(synced.after, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncOriginFromMirror: an unreachable upstream leaves the origin's tracking ref alone", () => {
  const fx = staleSatelliteOrigin();
  try {
    g(fx.origin, ["remote", "set-url", "origin", join(fx.root, "missing.git")]);
    const synced = fx.sync();
    assert.equal(synced.refresh.status, "failed");
    assert.equal(synced.after, fx.stale);
    assert.equal(g(fx.origin, ["rev-parse", "refs/remotes/origin/main"]), fx.stale);
  } finally {
    fx.cleanup();
  }
});

test("syncOriginFromMirror: an origin tracking a non-default branch is not moved to the upstream default", () => {
  const fx = staleSatelliteOrigin();
  try {
    g(fx.author, ["push", "--quiet", "github", `${fx.stale}:refs/heads/feature`]);
    g(fx.origin, ["fetch", "--quiet", "origin", "feature:refs/remotes/origin/feature"]);
    g(fx.origin, ["checkout", "--quiet", "-b", "feature", "--track", "origin/feature"]);
    const synced = fx.sync();
    assert.equal(synced.refresh.status, "fetched");
    assert.equal(synced.trackingRef, null);
    assert.equal(g(fx.origin, ["rev-parse", "refs/remotes/origin/feature"]), fx.stale);
    assert.equal(resolveCellBase(fx.origin)?.sha, fx.stale);
  } finally {
    fx.cleanup();
  }
});

test("clone-provisioned Cell points origin at the real upstream, not the local origin path", () => {
  const fx = staleSatelliteOrigin();
  try {
    fx.sync();
    const cellsRoot = join(fx.root, "cells");
    const req = request(fx.origin, "bee-a", fx.fresh, "aaaaaaaaaaaa");
    reserveCell(cellsRoot, req);
    const cell = provisionCell(cellsRoot, req, "op-a", OPTS);
    assert.equal(cell.copyMode, "clone");
    const space = cell.paths.spaceDir;
    assert.equal(g(space, ["rev-parse", "HEAD"]), fx.fresh);
    assert.equal(g(space, ["remote", "get-url", "origin"]), fx.github);
    assert.equal(g(space, ["rev-parse", "refs/remotes/origin/main"]), fx.fresh);
    assert.equal(g(space, ["symbolic-ref", "refs/remotes/origin/HEAD"]), "refs/remotes/origin/main");
    assert.equal(g(space, ["rev-parse", "refs/heads/main"]), fx.fresh);
    assert.equal(g(space, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"]), "refs/remotes/origin/HEAD\nrefs/remotes/origin/main");
    commitOn(fx.author, "README.md", "# newer\n", "newer");
    g(fx.author, ["push", "--quiet", "github", "main"]);
    g(space, ["fetch", "--quiet", "origin", "main"]);
    assert.notEqual(g(space, ["rev-parse", "FETCH_HEAD"]), fx.fresh);
  } finally {
    fx.cleanup();
  }
});

test("pool claim refreshes the Cell's origin/main to the current upstream tip", () => {
  const fx = staleSatelliteOrigin();
  try {
    const cellsRoot = join(fx.root, "cells");
    buildPoolMember(cellsRoot, { originRepo: fx.origin, repoName: "material", sha: fx.stale }, OPTS, { racyIndexWindowMs: 0 });
    fx.sync();
    const req = request(fx.origin, "bee-b", fx.fresh, "bbbbbbbbbbbb");
    reserveCell(cellsRoot, req);
    const claimed = claimFromPool(cellsRoot, req);
    assert.ok(claimed);
    const space = claimed.paths.spaceDir;
    assert.equal(g(space, ["rev-parse", "HEAD"]), fx.fresh);
    assert.equal(g(space, ["remote", "get-url", "origin"]), fx.github);
    assert.equal(g(space, ["rev-parse", "refs/remotes/origin/main"]), fx.fresh);
  } finally {
    fx.cleanup();
  }
});

test("upstream.lock: a refresh waits for a concurrent one instead of failing into backoff, and a stale lock is taken over", () => {
  const fx = staleSatelliteOrigin();
  try {
    const mirror = mirrorDirFor(fx.upstreamRoot, fx.github);
    mkdirSync(`${mirror}.lock`, { recursive: true });
    const busy = refreshUpstreamMirror(fx.origin, fx.upstreamRoot, { maxAgeMs: 0, timeoutMs: 300 });
    assert.equal(busy.status, "failed");
    assert.equal(existsSync(join(mirror, "honeybee-fetch-failed-at")), false, "a busy mirror records no failure backoff");

    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(`${mirror}.lock`, old, old);
    const taken = refreshUpstreamMirror(fx.origin, fx.upstreamRoot, { maxAgeMs: 0, timeoutMs: 30_000 });
    assert.equal(taken.status, "fetched");
    assert.equal(taken.ref?.sha, fx.fresh);
    assert.equal(existsSync(`${mirror}.lock`), false, "the lock is released");
  } finally {
    fx.cleanup();
  }
});
