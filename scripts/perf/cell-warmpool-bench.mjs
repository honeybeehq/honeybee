#!/usr/bin/env node
/**
 * Warm-pool microbench: the Honeybee-owned provisioning segment a claim removes.
 *
 * Builds a realistic-size origin (default 3900 files, ~= the honeybee tree) and
 * times, on the same host and filesystem:
 *   - COLD: provisionCell (git clone --local + checkout) — today's spawn path.
 *   - CLAIM: buildPoolMember off-path, then claimFromPool (rename + ledger,
 *     exact sha, no delta) — the warm-pool spawn path.
 *
 * Reports medians in microseconds. This is the segment moved off the spawn
 * critical path; it is not an end-to-end spawn latency.
 *
 *   node scripts/perf/cell-warmpool-bench.mjs [--files 3900] [--samples 10] [--out bench.json]
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url).pathname;
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const files = Number(opt("--files", "3900"));
const samples = Number(opt("--samples", "10"));
const out = opt("--out", "");

// Import the provisioning + pool modules directly (not index.ts) so the bench
// needs only the driver-cell source, runnable on a satellite from a partial
// source copy without the daemon/driver-hsr graph or node_modules.
const prov = await import(pathToFileURL(join(root, "v2/driver-cell/src/provision.ts")).href);
const pool = await import(pathToFileURL(join(root, "v2/driver-cell/src/warmPool.ts")).href);
const { provisionCell, reserveCell } = prov;
const { buildPoolMember, claimFromPool, repoKeyFor } = pool;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "b", GIT_AUTHOR_EMAIL: "b@b", GIT_COMMITTER_NAME: "b", GIT_COMMITTER_EMAIL: "b@b" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}
function makeOrigin(base) {
  const repo = join(base, "origin");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-b", "main"]);
  for (let i = 0; i < files; i++) {
    const d = join(repo, "src", `d${i % 40}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `file-${i}.ts`), `export const v${i} = ${i};\n`.repeat(24));
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "fixture"]);
  return { repo, sha: git(repo, ["rev-parse", "HEAD"]) };
}
const OPTS = { disableCow: false, useGitImages: false }; // real CoW where the FS supports it, no git-images (satellite-like)
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const us = (ms) => Math.round(ms * 1000);

const base = mkdtempSync(join(tmpdir(), "wp-bench-"));
try {
  const origin = makeOrigin(base);
  const cold = [], claim = [];
  // warm the page cache with one throwaway cold provision
  { const c = join(base, "warm"); mkdirSync(c); provisionCell(c, { beeId: "warm", originRepo: origin.repo, sha: origin.sha, wrapper: "w", repoName: "origin", cellId: "warm00000000" }, "op-warm", OPTS); }
  for (let i = 0; i < samples; i++) {
    // COLD
    const cr = join(base, `cold-${i}`); mkdirSync(cr);
    const req = { beeId: `c${i}`, originRepo: origin.repo, sha: origin.sha, wrapper: `w${i}`, repoName: "origin", cellId: `cold${String(i).padStart(8, "0")}` };
    let t = performance.now();
    provisionCell(cr, req, `op-cold-${i}`, OPTS);
    cold.push(performance.now() - t);
    // CLAIM: build a member off-path (untimed), then time the claim only.
    const pr = join(base, `pool-${i}`); mkdirSync(pr);
    buildPoolMember(pr, { originRepo: origin.repo, repoName: "origin", sha: origin.sha }, OPTS);
    const breq = { beeId: `p${i}`, originRepo: origin.repo, sha: origin.sha, wrapper: `pw${i}`, repoName: "origin", cellId: `pool${String(i).padStart(8, "0")}` };
    reserveCell(pr, { ...breq });
    t = performance.now();
    const claimed = claimFromPool(pr, breq);
    claim.push(performance.now() - t);
    if (!claimed) throw new Error("claim missed a freshly built member");
  }
  const report = {
    host: hostname(), files, samples, load: loadavg(),
    coldProvisionUs: { p50: us(median(cold)), min: us(Math.min(...cold)), max: us(Math.max(...cold)) },
    poolClaimUs: { p50: us(median(claim)), min: us(Math.min(...claim)), max: us(Math.max(...claim)) },
    speedup: +(median(cold) / median(claim)).toFixed(1),
    note: "cold = git clone --local + checkout on the spawn path; claim = rename + ledger rewrite (exact sha). Member build is off-path and untimed.",
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
} finally {
  rmSync(base, { recursive: true, force: true });
}
