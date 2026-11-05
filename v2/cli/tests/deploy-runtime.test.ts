import { backupStoreOffline } from "../../core/src/storeBackup.ts";
// Spec 00 (reset WP0) — versioned deploys. Exercises the full deploy state
// machine (src/deployRuntime.ts) against a temp runtime root and a real
// fixture git repo, with the build and daemon-restart hooks injected so no
// test ever compiles the repo or restarts anything real.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  CURRENT_LINK_NAME,
  DEPLOY_HISTORY_FILENAME,
  currentDeployTarget,
  deployVersion,
  pruneRuntimeVersions,
  readDeployHistory,
  rollbackDeploy,
  rollbackTargetEntry,
  DeployActivationHeldError,
  DeployActivationRefusedError,
  DeployRollbackError,
  type BuildArtifactContext,
  type DeployHooks,
  type RestartDaemonContext,
} from "../src/deploy/runtime.ts";

const execFileAsync = promisify(execFile);

async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args]);
  return stdout.trim();
}

/** Fixture repo with real commits; each commit's marker.txt names its build output. */
async function makeRepo(root: string): Promise<{ repoRoot: string; commit: (marker: string) => Promise<string> }> {
  const repoRoot = join(root, "repo");
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", repoRoot]);
  const commit = async (marker: string): Promise<string> => {
    await writeFile(join(repoRoot, "marker.txt"), `${marker}\n`);
    await git(repoRoot, "add", "-A");
    await git(
      repoRoot,
      "-c", "user.name=deploy-test",
      "-c", "user.email=deploy-test@hive",
      "commit", "-q", "-m", `marker ${marker}`,
    );
    return git(repoRoot, "rev-parse", "HEAD");
  };
  return { repoRoot, commit };
}

type HookLog = {
  builds: string[];
  restarts: Array<{ sha: string; currentAtRestart: string | null }>;
};

/**
 * Fake build: reads the committed marker for the requested sha (via git show,
 * so a dirty working tree can never leak in) and emits a runnable dist/cli.js
 * that prints it. Restart records what `current` pointed at when it ran.
 */
function fakeHooks(root: string): { hooks: DeployHooks; log: HookLog } {
  const log: HookLog = { builds: [], restarts: [] };
  const hooks: DeployHooks = {
    async backupStore() { return backupStoreOffline(join(root, "..", "v2", "core.sqlite3"), "fixture"); },
    async buildArtifact({ repoRoot, sha, workDir }: BuildArtifactContext) {
      log.builds.push(sha);
      const marker = (await git(repoRoot, "show", `${sha}:marker.txt`)).trim();
      const stage = join(workDir, "stage");
      await mkdir(join(stage, "dist", "v2"), { recursive: true });
      await writeFile(join(stage, "dist", "v2", "cli.js"), "var SCHEMA_VERSION = 48;\n");
      await writeFile(join(stage, "dist", "cli.js"), `console.log(${JSON.stringify(marker)});\n`);
      await writeFile(join(stage, "package.json"), `${JSON.stringify({ name: "honeybee", version: "0.0.1" })}\n`);
      return { artifactDir: stage };
    },
    async restartDaemon({ sha }: RestartDaemonContext) {
      log.restarts.push({ sha, currentAtRestart: await currentDeployTarget(root) });
    },
  };
  return { hooks, log };
}

async function withDeployWorld(
  fn: (world: {
    root: string;
    repoRoot: string;
    commit: (marker: string) => Promise<string>;
    hooks: DeployHooks;
    log: HookLog;
  }) => Promise<void>,
): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "hive-deploy-test-"));
  const root = join(temp, "runtime");
  try {
    const { repoRoot, commit } = await makeRepo(temp);
    const { hooks, log } = fakeHooks(root);
    await fn({ root, repoRoot, commit, hooks, log });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function runInstalledCli(root: string): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(root, CURRENT_LINK_NAME, "dist", "cli.js")],
  );
  return stdout.trim();
}

test("missing current history is reconciled once with a verified native committed identity", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const sha = await commit("current-with-lost-ack");
    await deployVersion({ root, repoRoot, hooks });
    await writeFile(join(root, sha, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, component: "honeybee", version: "0.0.1", packageVersion: "0.0.1", sourceRevision: sha, dirty: false, release: false, target: `${process.platform}-${process.arch}` }));
    await rm(join(root, DEPLOY_HISTORY_FILENAME));
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(rollbackDeploy({ root, hooks }), error => error instanceof DeployRollbackError && error.code === "ROLLBACK_PREVIOUS_INSTALL_MISSING");
      const entries = await readDeployHistory(root);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.sha, sha);
      assert.equal(entries[0]?.activation, "unconfirmed");
      assert.equal(rollbackTargetEntry(entries, "b".repeat(40))?.sha, sha);
    }
  });
});

test("an already incompatible store refuses before current or service activation changes", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    const previous = await commit("previous");
    await deployVersion({ root, repoRoot, hooks });
    const history = await readDeployHistory(root);
    const candidate = await commit("candidate");
    const dataDir = join(root, "..", "v2");
    await mkdir(dataDir, { recursive: true });
    const db = new DatabaseSync(join(dataDir, "core.sqlite3"));
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT; INSERT INTO meta VALUES('schema_version','51')");
    db.close();
    await assert.rejects(deployVersion({ root, repoRoot, hooks }), DeployActivationRefusedError);
    assert.equal(await currentDeployTarget(root), previous);
    assert.deepEqual(await readDeployHistory(root), history);
    assert.equal(log.restarts.length, 1);
    assert.equal(existsSync(join(root, candidate)), false);
  });
});

for (const invalid of ["revision", "dirty", "target"] as const) {
  test(`history reconciliation refuses an unverified current identity: ${invalid}`, async () => {
    await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
      const sha = await commit("unverified-current");
      await deployVersion({ root, repoRoot, hooks });
      await writeFile(join(root, sha, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, component: "honeybee", version: "0.0.1", packageVersion: "0.0.1", sourceRevision: invalid === "revision" ? "b".repeat(40) : sha, dirty: invalid === "dirty", release: false, target: invalid === "target" ? "foreign-target" : `${process.platform}-${process.arch}` }));
      await rm(join(root, DEPLOY_HISTORY_FILENAME));
      await assert.rejects(rollbackDeploy({ root, hooks }), error => error instanceof DeployRollbackError && error.code === "ROLLBACK_CURRENT_IDENTITY_MISSING");
      assert.deepEqual(await readDeployHistory(root), []);
      assert.equal(await currentDeployTarget(root), sha);
    });
  });
}

test("a held activation records current without attempting another restore", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const previous = await commit("previous");
    await deployVersion({ root, repoRoot, hooks });
    const candidate = await commit("migrating");
    await assert.rejects(deployVersion({ root, repoRoot, hooks: { ...hooks, async restartDaemon() { throw new DeployActivationHeldError(candidate, "migrated candidate retained"); } } }), DeployActivationHeldError);
    assert.equal(await currentDeployTarget(root), candidate);
    const entries = await readDeployHistory(root);
    assert.equal(entries.at(-1)?.activation, "held");
    assert.equal(entries.at(-1)?.sha, candidate);
    assert.equal(rollbackTargetEntry(entries, previous)?.sha, candidate);
  });
});

test("failed rollback to an unconfirmed activation recovers current and reports its uncertainty", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const previous = await commit("unconfirmed");
    await deployVersion({ root, repoRoot, hooks });
    const current = await commit("current");
    await deployVersion({ root, repoRoot, hooks });
    const entries = await readDeployHistory(root);
    entries[0]!.activation = "unconfirmed";
    await writeFile(join(root, DEPLOY_HISTORY_FILENAME), JSON.stringify({ schemaVersion: 1, entries }));
    const lines: string[] = [];
    await assert.rejects(rollbackDeploy({ root, log: line => lines.push(line), hooks: { ...hooks, async restartDaemon(context) {
      assert.equal(await currentDeployTarget(root), previous);
      await context.restorePrevious?.();
      throw new Error("fixture boot failure after safe recovery");
    } } }), /fixture boot failure/);
    assert.equal(await currentDeployTarget(root), current);
    assert.deepEqual(await readDeployHistory(root), entries);
    assert.ok(lines.some(line => line.includes("target activation unconfirmed")));
  });
});

async function seedStore(root: string): Promise<void> {
  const data = join(root, "..", "v2");
  await mkdir(data, { recursive: true });
  const db = new DatabaseSync(join(data, "core.sqlite3"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('schema_version', '58')").run();
  } finally { db.close(); }
}

// 1. deploy from clean HEAD installs, switches `current` atomically, restarts daemon
test("deploy from clean HEAD installs the version, retargets current, records history, restarts daemon", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    const sha = await commit("v1");
    const outcome = await deployVersion({ repoRoot, root, hooks, by: "tester" });

    assert.equal(outcome.sha, sha);
    assert.equal(outcome.previousSha, null);
    assert.ok(existsSync(join(root, sha, "dist", "cli.js")));
    // `current` is a relative symlink naming exactly the sha.
    assert.equal(await readlink(join(root, CURRENT_LINK_NAME)), sha);
    // History carries the spec'd record shape.
    const entries = await readDeployHistory(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.sha, sha);
    assert.equal(entries[0]!.by, "tester");
    assert.equal(entries[0]!.gate, "full");
    assert.equal(entries[0]!.artifactHash, outcome.artifactHash);
    assert.ok(entries[0]!.artifactHash.length === 64);
    assert.ok(Number.isFinite(Date.parse(entries[0]!.at)));
    // The daemon restart is the separate final step and already saw the new target.
    assert.equal(log.restarts.length, 1);
    assert.deepEqual(log.restarts[0], { sha, currentAtRestart: sha });
    const leftovers = (await readdir(root)).filter((name) => name.startsWith("."));
    assert.deepEqual(leftovers, [".store-absence"]);
    const absence = (await readdir(join(root, ".store-absence")))[0]!;
    assert.equal(JSON.parse(await readFile(join(root, ".store-absence", absence), "utf8")).kind, "store_absent");
  });
});

test("deploy accepts an explicit sha that is not HEAD", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const first = await commit("v1");
    await commit("v2");
    const outcome = await deployVersion({ repoRoot, root, ref: first, hooks });
    assert.equal(outcome.sha, first);
    assert.equal(await currentDeployTarget(root), first);
    assert.equal(await runInstalledCli(root), "v1");
  });
});

// 2. dirty tree refuses before building
test("a dirty working tree refuses before building", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    await commit("v1");
    await writeFile(join(repoRoot, "marker.txt"), "uncommitted edit\n");
    await assert.rejects(
      deployVersion({ repoRoot, root, hooks }),
      /working tree is dirty/,
    );
    assert.deepEqual(log.builds, []);
    assert.deepEqual(log.restarts, []);
    assert.equal(existsSync(root), false);
  });
});

test("an untracked file also counts as dirty", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    await commit("v1");
    await writeFile(join(repoRoot, "scratch.txt"), "untracked\n");
    await assert.rejects(deployVersion({ repoRoot, root, hooks }), /working tree is dirty/);
    assert.deepEqual(log.builds, []);
  });
});

// 3. failing tests/build refuse before touching ~/.hive/runtime
test("a failing build never touches the runtime root, current, or history", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    const good = await commit("v1");
    await deployVersion({ repoRoot, root, hooks });
    await commit("v2");
    const failing: DeployHooks = {
      buildArtifact: async () => {
        throw new Error("check suite failed: 3 tests red");
      },
      restartDaemon: hooks.restartDaemon,
    };
    await assert.rejects(
      deployVersion({ repoRoot, root, hooks: failing }),
      /check suite failed/,
    );
    // current still names the good deploy; nothing new installed or recorded.
    assert.equal(await currentDeployTarget(root), good);
    const versionDirs = (await readdir(root)).filter((name) => /^[0-9a-f]{40}$/.test(name));
    assert.deepEqual(versionDirs, [good]);
    assert.equal((await readDeployHistory(root)).length, 1);
    assert.equal(log.restarts.length, 1);
    // No staging debris left behind either.
    const leftovers = (await readdir(root)).filter((name) => name.startsWith(".staging"));
    assert.deepEqual(leftovers, []);
  });
});

test("an artifact without dist/cli.js is refused before install", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    await commit("v1");
    const empty: DeployHooks = {
      buildArtifact: async ({ workDir }) => {
        const stage = join(workDir, "stage");
        await mkdir(stage, { recursive: true });
        return { artifactDir: stage };
      },
      restartDaemon: hooks.restartDaemon,
    };
    await assert.rejects(deployVersion({ repoRoot, root, hooks: empty }), /no dist\/cli\.js/);
    assert.equal(await currentDeployTarget(root), null);
    assert.deepEqual(log.restarts, []);
  });
});

// 4. rollback restores the previous target and daemon
test("rollback retargets current to the previous deploy and restarts the daemon", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    const first = await commit("v1");
    await deployVersion({ repoRoot, root, hooks });
    const second = await commit("v2");
    await deployVersion({ repoRoot, root, hooks });
    assert.equal(await runInstalledCli(root), "v2");

    const outcome = await rollbackDeploy({ root, hooks, by: "tester" });
    assert.equal(outcome.from, second);
    assert.equal(outcome.sha, first);
    assert.equal(await currentDeployTarget(root), first);
    assert.equal(await runInstalledCli(root), "v1");
    // Rollback appends to history (current always corresponds to the last entry).
    const entries = await readDeployHistory(root);
    assert.deepEqual(entries.map((entry) => entry.sha), [first, second, first]);
    assert.equal(entries[2]!.artifactHash, entries[0]!.artifactHash);
    assert.equal(log.restarts.length, 3);
    assert.deepEqual(log.restarts[2], { sha: first, currentAtRestart: first });
  });
});

test("rollback refuses when there is no previous installed version", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    await assert.rejects(rollbackDeploy({ root, hooks }), /nothing deployed yet/);
    await commit("v1");
    await deployVersion({ repoRoot, root, hooks });
    await assert.rejects(rollbackDeploy({ root, hooks }), /no previous installed version/);
  });
});

// 5. prune keeps current + rollback target + last N
test("prune keeps current, the rollback target, and the last N versions", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const shas: string[] = [];
    for (const marker of ["v1", "v2", "v3", "v4"]) {
      shas.push(await commit(marker));
      await deployVersion({ repoRoot, root, hooks, keep: 1 });
    }
    const [s1, s2, s3, s4] = shas as [string, string, string, string];
    const versionDirs = (await readdir(root)).filter((name) => /^[0-9a-f]{40}$/.test(name)).sort();
    // keep=1 protects only s4; s3 survives as the rollback target.
    assert.deepEqual(versionDirs, [s3, s4].sort());
    assert.equal(existsSync(join(root, s1)), false);
    assert.equal(existsSync(join(root, s2)), false);
    // Idempotent: pruning again removes nothing further.
    assert.deepEqual(await pruneRuntimeVersions(root, { keep: 1 }), []);
    // History remains complete even for pruned versions.
    assert.deepEqual((await readDeployHistory(root)).map((entry) => entry.sha), shas);
  });
});

test("prune never removes the rollback target even after rolling back", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const first = await commit("v1");
    await deployVersion({ repoRoot, root, hooks, keep: 1 });
    const second = await commit("v2");
    await deployVersion({ repoRoot, root, hooks, keep: 1 });
    await rollbackDeploy({ root, hooks });
    // current=first; rollback target=second (the entry we rolled away from).
    assert.deepEqual(await pruneRuntimeVersions(root, { keep: 1 }), []);
    assert.ok(existsSync(join(root, first)));
    assert.ok(existsSync(join(root, second)));
  });
});

// 6. `hive` resolves through `current`; working-tree edits are inert until the next deploy
test("the installed CLI resolves through current and ignores working-tree edits until the next deploy", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    await commit("v1");
    await deployVersion({ repoRoot, root, hooks });
    assert.equal(await runInstalledCli(root), "v1");

    // Edit the working tree: the installed runtime must not change at all.
    await writeFile(join(repoRoot, "marker.txt"), "v2-uncommitted\n");
    assert.equal(await runInstalledCli(root), "v1");
    // And a deploy over that dirty tree refuses outright.
    await assert.rejects(deployVersion({ repoRoot, root, hooks }), /working tree is dirty/);
    assert.equal(await runInstalledCli(root), "v1");

    // Only committing + deploying moves the resolved version.
    await commit("v2");
    await deployVersion({ repoRoot, root, hooks });
    assert.equal(await runInstalledCli(root), "v2");
  });
});

test("redeploying the same sha replaces the install without breaking current", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const sha = await commit("v1");
    await deployVersion({ repoRoot, root, hooks });
    const before = await readFile(join(root, sha, "dist", "cli.js"), "utf8");
    await deployVersion({ repoRoot, root, hooks });
    const after = await readFile(join(root, sha, "dist", "cli.js"), "utf8");
    assert.equal(before, after);
    assert.equal(await currentDeployTarget(root), sha);
    assert.equal((await readDeployHistory(root)).length, 2);
    assert.equal(await runInstalledCli(root), "v1");
  });
});

test("deploy history tolerates a missing or foreign deploys.json", async () => {
  const temp = await mkdtemp(join(tmpdir(), "hive-deploy-history-"));
  try {
    assert.deepEqual(await readDeployHistory(join(temp, "nope")), []);
    await writeFile(join(temp, DEPLOY_HISTORY_FILENAME), "not json at all");
    assert.deepEqual(await readDeployHistory(temp), []);
    await writeFile(join(temp, DEPLOY_HISTORY_FILENAME), JSON.stringify({ entries: [{ sha: "short" }, 42] }));
    assert.deepEqual(await readDeployHistory(temp), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

// 10. ancestry guard (2026-08-21): a deploy that does not contain the running
// commit is a silent revert of landed work — refuse it; descendants, explicit
// overrides, and same-sha redeploys stay allowed.
test("ancestry guard: non-descendant refused, descendant allowed, override honored", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const base = await commit("base");
    const a = await commit("A");
    await deployVersion({ repoRoot, ref: a, root, hooks });

    // A sibling branched BELOW the deployed commit does not contain it.
    await git(repoRoot, "checkout", "-q", "-B", "regress", base);
    const b = await commit("B-sibling");
    await assert.rejects(
      deployVersion({ repoRoot, ref: b, root, hooks }),
      /does not contain the currently deployed/,
    );
    assert.equal(await currentDeployTarget(root), a, "refused deploy must not move current");

    // The override deploys it anyway (deliberate non-linear replacement).
    await deployVersion({ repoRoot, ref: b, root, hooks, allowNonDescendant: true });
    assert.equal(await currentDeployTarget(root), b);

    // A descendant of the running commit deploys without ceremony.
    await git(repoRoot, "checkout", "-q", "regress");
    const c = await commit("C-descendant");
    await deployVersion({ repoRoot, ref: c, root, hooks });
    assert.equal(await currentDeployTarget(root), c);

    // Redeploying the exact running sha is always allowed (idempotent repair).
    await deployVersion({ repoRoot, ref: c, root, hooks });
    assert.equal(await currentDeployTarget(root), c);
  });
});

for (const skipTests of [false, true]) {
  test(`deploy threads skipTests=${skipTests} into the build and records its gate`, async () => {
    await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
      await commit("skip-tests");
      let observed: boolean | undefined;
      const outcome = await deployVersion({ repoRoot, root, skipTests, hooks: {
        ...hooks,
        buildArtifact: async (context) => {
          observed = context.skipTests;
          return hooks.buildArtifact(context);
        },
      } });
      assert.equal(observed, skipTests);
      assert.equal(outcome.entry.gate, skipTests ? "tests-skipped" : "full");
      assert.equal((await readDeployHistory(root))[0]!.gate, outcome.entry.gate);
    });
  });
}
test("failed activation restores current and preserves successful deploy history", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const old = await commit("old");
    await deployVersion({ repoRoot, root, hooks });
    const history = await readDeployHistory(root);
    await commit("new");
    await assert.rejects(deployVersion({ repoRoot, root, hooks: { ...hooks, async restartDaemon(ctx) {
      assert.equal(await ctx.restorePrevious?.(), true);
      assert.equal(await currentDeployTarget(root), old);
      throw new Error("forced activation failure");
    } } }), /forced activation failure/);
    assert.equal(await currentDeployTarget(root), old);
    assert.equal(await runInstalledCli(root), "old");
    assert.deepEqual(await readDeployHistory(root), history);
  });
});

test("failed same-revision activation restores displaced runtime bytes", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    await commit("old");
    await deployVersion({ repoRoot, root, hooks });
    const history = await readDeployHistory(root);
    await assert.rejects(deployVersion({ repoRoot, root, hooks: { ...hooks,
      async buildArtifact(ctx) { const stage = await hooks.buildArtifact(ctx); await writeFile(join(stage.artifactDir, "dist", "cli.js"), 'console.log("replacement")'); return stage; },
      async restartDaemon(ctx) { await ctx.restorePrevious?.(); throw new Error("forced same revision failure"); },
    } }), /forced same revision failure/);
    assert.equal(await runInstalledCli(root), "old");
    assert.deepEqual(await readDeployHistory(root), history);
  });
});

test("failed rollback restores the active version without recording success", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    await commit("old"); await deployVersion({ repoRoot, root, hooks });
    const active = await commit("active"); await deployVersion({ repoRoot, root, hooks });
    const history = await readDeployHistory(root);
    await assert.rejects(rollbackDeploy({ root, hooks: { async restartDaemon(ctx) { await ctx.restorePrevious?.(); throw new Error("forced rollback failure"); } } }), /forced rollback failure/);
    assert.equal(await currentDeployTarget(root), active);
    assert.equal(await runInstalledCli(root), "active");
    assert.deepEqual(await readDeployHistory(root), history);
  });
});

test("successful deploy retains an external current absent from history as the next rollback target", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const first = await commit("apiary current");
    await deployVersion({ root, repoRoot, ref: first, hooks });
    await writeFile(join(root, first, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, component: "honeybee", version: "0.0.1", packageVersion: "0.0.1", sourceRevision: first, dirty: false, release: true, target: `${process.platform}-${process.arch}` }));
    const external = join(root, "apiary-content-address");
    await rename(join(root, first), external);
    await rm(join(root, "current"));
    await symlink(external, join(root, "current"));
    await writeFile(join(root, DEPLOY_HISTORY_FILENAME), JSON.stringify({ schemaVersion: 1, entries: [] }));
    const second = await commit("candidate");
    await deployVersion({ root, repoRoot, ref: second, keep: 1, hooks });
    assert.ok(existsSync(join(root, first, "dist", "cli.js")));
    assert.deepEqual((await readDeployHistory(root)).map(entry => entry.sha), [first, second]);
    assert.equal((await rollbackDeploy({ root, hooks })).sha, first);
    assert.equal(await runInstalledCli(root), "apiary current");
  });
});

for (const invalid of ["target", "conflicting-install", "escaping-link"] as const) test(`external preservation refuses ${invalid} before installing the candidate`, async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const first = await commit("apiary current");
    await deployVersion({ root, repoRoot, ref: first, hooks });
    await writeFile(join(root, first, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, component: "honeybee", version: "0.0.1", packageVersion: "0.0.1", sourceRevision: first, dirty: false, release: true, target: invalid === "target" ? "wrong-target" : `${process.platform}-${process.arch}` }));
    const external = join(root, "apiary-content-address");
    await rename(join(root, first), external);
    await rm(join(root, "current"));
    await symlink(external, join(root, "current"));
    if (invalid === "conflicting-install") { await mkdir(join(root, first)); await writeFile(join(root, first, "different"), "conflict"); }
    if (invalid === "escaping-link") await symlink(join(repoRoot, "marker.txt"), join(external, "escape"));
    const second = await commit("candidate");
    await assert.rejects(deployVersion({ root, repoRoot, ref: second, hooks }), invalid === "target" ? /ROLLBACK_CURRENT_IDENTITY_MISSING/ : invalid === "conflicting-install" ? /ROLLBACK_PREVIOUS_INSTALL_CONFLICT/ : /unsafe archive link/);
    assert.equal(await readlink(join(root, "current")), external);
    assert.equal(existsSync(join(root, second)), false);
    assert.equal((await readdir(root)).some(name => name.startsWith(".previous.") || name.startsWith(".displaced.")), false);
  });
});

test("same-sha failed activation checks displaced schema before restoring bytes and preserves the previous build", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const sha = await commit("same revision");
    let builds = 0;
    const selected: DeployHooks = {
      async buildArtifact(context) {
        const artifact = await hooks.buildArtifact(context);
        builds += 1;
        await writeFile(join(artifact.artifactDir, "dist", "v2", "cli.js"), `var SCHEMA_VERSION = ${builds === 1 ? 44 : 48};\n`);
        return artifact;
      },
      async restartDaemon() {
        if (builds < 2) return;
        const data = join(root, "..", "v2");
        await mkdir(data);
        const db = new DatabaseSync(join(data, "core.sqlite3"));
        db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('schema_version','48')");
        db.close();
        throw new Error("candidate boot failed after migration");
      },
    };
    await deployVersion({ root, repoRoot, ref: sha, hooks: selected });
    const history = await readDeployHistory(root);
    await assert.rejects(deployVersion({ root, repoRoot, ref: sha, hooks: selected }), /ROLLBACK_STORE_NEWER_THAN_TARGET/);
    assert.equal(await readFile(join(root, sha, "dist", "v2", "cli.js"), "utf8"), "var SCHEMA_VERSION = 48;\n");
    const displaced = (await readdir(root)).find(name => name.startsWith(`.displaced.${sha}.`));
    assert.ok(displaced);
    assert.equal(await readFile(join(root, displaced, "dist", "v2", "cli.js"), "utf8"), "var SCHEMA_VERSION = 44;\n");
    assert.deepEqual(await readDeployHistory(root), history);
  });
});

test("backup refusal leaves current and same-revision runtime bytes untouched", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks }) => {
    const sha = await commit("v1");
    await deployVersion({ root, repoRoot, hooks });
    const before = await readFile(join(root, sha, "dist", "cli.js"), "utf8");
    await seedStore(root);
    const originalBuild = hooks.buildArtifact;
    const refused = { ...hooks,
      async buildArtifact(context: BuildArtifactContext) {
        const artifact = await originalBuild(context);
        await writeFile(join(artifact.artifactDir, "dist", "cli.js"), "changed");
        return artifact;
      },
      async backupStore() { throw new Error("backup finalization failed"); },
    };
    await assert.rejects(deployVersion({ root, repoRoot, hooks: refused }), /backup finalization failed/);
    assert.equal(await currentDeployTarget(root), sha);
    assert.equal(await readFile(join(root, sha, "dist", "cli.js"), "utf8"), before);
    assert.equal((await readDeployHistory(root)).length, 1);
  });
});

test("existing store requires a durable validated backup before source deploy activation", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    await commit("backup");
    await seedStore(root);
    const missing = { ...hooks, backupStore: undefined };
    await assert.rejects(deployVersion({ root, repoRoot, hooks: missing }), /backup owner is required/);
    const invalid = { ...hooks, async backupStore() { const path = join(root, "receipt.json"); await writeFile(path, '{}'); return { receiptPath: path }; } };
    await assert.rejects(deployVersion({ root, repoRoot, hooks: invalid }), /invalid store backup receipt/);
    assert.equal(await currentDeployTarget(root), null);
    assert.deepEqual(log.restarts, []);
    let backupCurrent: string | null | undefined;
    const valid = { ...hooks, async backupStore() {
      backupCurrent = await currentDeployTarget(root);
      return backupStoreOffline(join(root, "..", "v2", "core.sqlite3"), "fixture");
    } };
    await deployVersion({ root, repoRoot, hooks: valid });
    assert.equal(backupCurrent, null);
    assert.equal(log.restarts.length, 1);
  });
});

test("a custom environment data directory refuses deploy before the no-store shortcut", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    await commit("custom-data");
    const previous = process.env.HIVE_V2_DATA_DIR;
    process.env.HIVE_V2_DATA_DIR = join(root, "other-data");
    try {
      await assert.rejects(deployVersion({ root, repoRoot, hooks }), /custom HIVE_V2_DATA_DIR.*refusing swap/);
      assert.equal(await currentDeployTarget(root), null);
      assert.deepEqual(log.restarts, []);
      assert.equal(existsSync(join(root, ".store-absence")), false);
    } finally {
      if (previous === undefined) delete process.env.HIVE_V2_DATA_DIR;
      else process.env.HIVE_V2_DATA_DIR = previous;
    }
  });
});

test("custom config store paths refuse before recording a store-absence receipt", async () => {
  await withDeployWorld(async ({ root, repoRoot, commit, hooks, log }) => {
    await commit("custom-config-store");
    const dataDir = join(root, "..", "v2");
    const guarded = { ...hooks, async buildArtifact(context: BuildArtifactContext) {
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "config.json"), JSON.stringify({ storePath: join(dataDir, "other.sqlite3") }));
      return hooks.buildArtifact(context);
    } };
    await assert.rejects(deployVersion({ root, repoRoot, hooks: guarded }), /custom store\/socket configuration.*refusing swap/);
    assert.equal(await currentDeployTarget(root), null);
    assert.equal(existsSync(join(root, ".store-absence")), false);
    assert.deepEqual(log.restarts, []);
  });
});
