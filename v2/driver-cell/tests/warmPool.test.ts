/**
 * Warm Cell pool safety invariants (spawn-floor work, 2026-09-21).
 *
 * Covers the contract the daemon relies on: a claim serves only a clean,
 * reachable member; provisioning replay/idempotency survives a claim; a stale
 * or dirty member is never handed out; concurrent spawns cannot double-claim.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  buildPoolMember,
  claimFromPool,
  listPoolMembers,
  poolMemberCount,
  reapPool,
  repoKeyFor,
} from "../src/warmPool.ts";
import { reserveCell, provisionCell, type ProvisionRequest } from "../src/provision.ts";
import { isProvisioned, readLedger } from "../src/ledger.ts";
import { cellPaths } from "../src/layout.ts";
import { g, makeOrigin, commitOn } from "./helpers.ts";

const OPTS = { disableCow: true, useGitImages: false } as const;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "warmpool-"));
  const cellsRoot = join(root, "cells");
  const origin = makeOrigin(root);
  return { root, cellsRoot, origin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function reserve(cellsRoot: string, origin: { repo: string; sha: string }, beeId: string, sha?: string): ProvisionRequest {
  const req: ProvisionRequest = {
    beeId,
    originRepo: origin.repo,
    sha: sha ?? origin.sha,
    wrapper: `wrap-${beeId}`,
    repoName: "origin",
    cellId: createHash("sha256").update(beeId).digest("hex").slice(0, 12),
  };
  reserveCell(cellsRoot, { ...req });
  return req;
}

test("claim serves an exact-sha member and reaps it", () => {
  const { cellsRoot, origin, cleanup } = setup();
  try {
    const member = buildPoolMember(cellsRoot, { originRepo: origin.repo, repoName: "origin", sha: origin.sha }, OPTS);
    assert.ok(member);
    assert.equal(poolMemberCount(cellsRoot, repoKeyFor(origin.repo, "origin")), 1);

    const req = reserve(cellsRoot, origin, "bee-exact");
    const claimed = claimFromPool(cellsRoot, req);
    assert.ok(claimed, "expected a claim");
    assert.equal(claimed!.sha, origin.sha);
    // The bee's own cell now has a checkout at the wanted sha.
    const paths = cellPaths(cellsRoot, req.wrapper, req.repoName, req.cellId);
    assert.equal(g(paths.spaceDir, ["rev-parse", "HEAD"]), origin.sha);
    assert.equal(g(paths.spaceDir, ["status", "--porcelain"]), "");
    const ledger = readLedger(paths.ledgerPath);
    assert.ok(ledger && isProvisioned(ledger), "bee ledger must be provisioned after a claim");
    assert.equal(ledger!.beeId, "bee-exact");
    // Member consumed.
    assert.equal(poolMemberCount(cellsRoot, repoKeyFor(origin.repo, "origin")), 0);
  } finally {
    cleanup();
  }
});

test("provisionCell replays (no re-clone) after a claim — idempotency survives the pool", () => {
  const { cellsRoot, origin, cleanup } = setup();
  try {
    buildPoolMember(cellsRoot, { originRepo: origin.repo, repoName: "origin", sha: origin.sha }, OPTS);
    const req = reserve(cellsRoot, origin, "bee-replay");
    const claimed = claimFromPool(cellsRoot, req);
    assert.ok(claimed);
    // The daemon's start() still runs provisionCell against the (now provisioned)
    // ledger; it must short-circuit rather than clone over the claimed tree.
    const result = provisionCell(cellsRoot, req, `start-bee-replay-g1`, OPTS);
    assert.equal(result.replayed, true);
    const paths = cellPaths(cellsRoot, req.wrapper, req.repoName, req.cellId);
    assert.equal(g(paths.spaceDir, ["rev-parse", "HEAD"]), origin.sha);
  } finally {
    cleanup();
  }
});

test("claim applies a checkout delta to a reachable older sha", () => {
  const { cellsRoot, origin, cleanup } = setup();
  try {
    const sha1 = origin.sha;
    const sha2 = commitOn(origin.repo, "src/added.ts", "export const two = 2;\n", "second");
    // Build the member at HEAD (sha2); it contains sha1 as an ancestor.
    buildPoolMember(cellsRoot, { originRepo: origin.repo, repoName: "origin", sha: sha2 }, OPTS);
    const req = reserve(cellsRoot, origin, "bee-delta", sha1);
    const claimed = claimFromPool(cellsRoot, req);
    assert.ok(claimed, "member holding sha2 should serve sha1 via a delta");
    const paths = cellPaths(cellsRoot, req.wrapper, req.repoName, req.cellId);
    assert.equal(g(paths.spaceDir, ["rev-parse", "HEAD"]), sha1);
    assert.equal(g(paths.spaceDir, ["status", "--porcelain"]), "");
    assert.ok(!existsSync(join(paths.spaceDir, "src", "added.ts")), "delta must remove the sha2-only file");
  } finally {
    cleanup();
  }
});

test("a member that cannot reach the wanted sha is discarded, not served", () => {
  const { cellsRoot, origin, cleanup } = setup();
  try {
    // Member built at sha1; bee wants sha2, which the member's clone lacks.
    buildPoolMember(cellsRoot, { originRepo: origin.repo, repoName: "origin", sha: origin.sha }, OPTS);
    const sha2 = commitOn(origin.repo, "src/added.ts", "export const two = 2;\n", "second");
    const req = reserve(cellsRoot, origin, "bee-unreach", sha2);
    const claimed = claimFromPool(cellsRoot, req);
    assert.equal(claimed, null, "an unreachable sha must not be served from the pool");
    assert.equal(poolMemberCount(cellsRoot, repoKeyFor(origin.repo, "origin")), 0, "stale member discarded");
  } finally {
    cleanup();
  }
});

test("a dirty member is never handed out", () => {
  const { cellsRoot, origin, cleanup } = setup();
  try {
    const member = buildPoolMember(cellsRoot, { originRepo: origin.repo, repoName: "origin", sha: origin.sha }, OPTS);
    // Dirty the member's working tree.
    const members = listPoolMembers(cellsRoot, repoKeyFor(origin.repo, "origin"));
    assert.equal(members.length, 1);
    writeFileSync(join(members[0]!.paths.spaceDir, "DIRTY.txt"), "uncommitted\n");
    const req = reserve(cellsRoot, origin, "bee-dirty");
    const claimed = claimFromPool(cellsRoot, req);
    assert.equal(claimed, null, "a dirty member must not be claimed");
    assert.equal(poolMemberCount(cellsRoot, repoKeyFor(origin.repo, "origin")), 0, "dirty member discarded");
    // The bee's cell was not populated by the failed claim.
    const paths = cellPaths(cellsRoot, req.wrapper, req.repoName, req.cellId);
    assert.ok(!existsSync(paths.spaceDir), "bee space must stay empty for the cold fallback");
    void member;
  } finally {
    cleanup();
  }
});

test("two concurrent claims cannot take the same member", () => {
  const { cellsRoot, origin, cleanup } = setup();
  try {
    buildPoolMember(cellsRoot, { originRepo: origin.repo, repoName: "origin", sha: origin.sha }, OPTS);
    const reqA = reserve(cellsRoot, origin, "bee-a");
    const reqB = reserve(cellsRoot, origin, "bee-b");
    const a = claimFromPool(cellsRoot, reqA);
    const b = claimFromPool(cellsRoot, reqB);
    const hits = [a, b].filter(Boolean).length;
    assert.equal(hits, 1, "exactly one of two claims may win the single member");
  } finally {
    cleanup();
  }
});

test("buildPoolMember honours maxSize", () => {
  const { cellsRoot, origin, cleanup } = setup();
  try {
    const req = { originRepo: origin.repo, repoName: "origin", sha: origin.sha };
    assert.ok(buildPoolMember(cellsRoot, req, OPTS, { maxSize: 1 }));
    assert.equal(buildPoolMember(cellsRoot, req, OPTS, { maxSize: 1 }), null, "must not exceed maxSize");
    assert.equal(poolMemberCount(cellsRoot, repoKeyFor(origin.repo, "origin")), 1);
  } finally {
    cleanup();
  }
});

test("reapPool drops stale-sha members and keeps current ones", () => {
  const { cellsRoot, origin, cleanup } = setup();
  try {
    const repoKey = repoKeyFor(origin.repo, "origin");
    buildPoolMember(cellsRoot, { originRepo: origin.repo, repoName: "origin", sha: origin.sha }, OPTS);
    const sha2 = commitOn(origin.repo, "src/added.ts", "export const two = 2;\n", "second");
    buildPoolMember(cellsRoot, { originRepo: origin.repo, repoName: "origin", sha: sha2 }, OPTS);
    assert.equal(poolMemberCount(cellsRoot, repoKey), 2);
    const removed = reapPool(cellsRoot, repoKey, sha2);
    assert.equal(removed, 1, "the sha1 member is stale");
    assert.equal(poolMemberCount(cellsRoot, repoKey), 1);
    assert.equal(listPoolMembers(cellsRoot, repoKey)[0]!.sha, sha2);
  } finally {
    cleanup();
  }
});

test("claim returns null (cold fallback) when the pool is empty", () => {
  const { cellsRoot, origin, cleanup } = setup();
  try {
    const req = reserve(cellsRoot, origin, "bee-empty");
    assert.equal(claimFromPool(cellsRoot, req), null);
    const wrapperDir = cellPaths(cellsRoot, req.wrapper, req.repoName, req.cellId).wrapperDir;
    // Only box/ exists (the seed); no space checkout was created.
    assert.deepEqual(readdirSync(wrapperDir), ["box"]);
  } finally {
    cleanup();
  }
});
