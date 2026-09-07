/**
 * Differential parity for the merge-tree clean-merge prototype (capture.ts).
 *
 * Every case runs the SAME production captureWork twice over an identical
 * fixture: once normally (object fast path eligible) and once with a PATH
 * shim whose `git` rejects `merge-tree` only — forcing the original
 * checkout/merge fallback — while every other command execs the real git
 * binary by absolute path. Commit dates are pinned, so when both engines
 * produce the same tree the landed commit shas are byte-identical; any
 * divergence in tree, parents, identity, message, refs, or report fields is
 * a real finding. Failures here are evidence about the prototype — do NOT
 * relax assertions to make them pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWork, type CaptureReport } from "../src/capture.ts";
import { g, makeOrigin } from "./helpers.ts";

const FIXED_DATE = "2026-09-07T00:00:00Z";

function realGitPath(): string {
  const res = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(res.status, 0, "real git not found");
  return res.stdout.trim();
}

interface Shim {
  dir: string;
  log: string;
}

/** A PATH-front `git` that logs each subcommand; optionally rejects merge-tree. */
function makeShim(root: string, name: string, rejectMergeTree: boolean): Shim {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const log = join(root, `${name}.log`);
  writeFileSync(log, "");
  const real = realGitPath();
  const reject = rejectMergeTree ? `[ "$1" = "merge-tree" ] && exit 129\n` : "";
  writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${log}"\n${reject}exec "${real}" "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  return { dir, log };
}

function withEnv(patch: Record<string, string>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface Fixture {
  root: string;
  origin: string;
  cell: string;
  targetTip: string;
  cellHead: string;
}

/**
 * Deterministic fixture: origin (main checked out), a `landing` target branch
 * shaped through a pushing clone (origin worktree untouched), and a cell
 * clone with its own commits. Dates pinned by the caller make all shas stable.
 */
function makeFixture(
  root: string,
  name: string,
  build: {
    base?: (repo: string) => void;
    target: (repo: string) => void;
    cell: (repo: string) => void;
  },
): Fixture {
  const { repo: origin } = makeOrigin(root, name);
  g(origin, ["config", "maintenance.auto", "false"]);
  g(origin, ["config", "gc.auto", "0"]);
  if (build.base) {
    build.base(origin);
    g(origin, ["add", "-A"]);
    g(origin, ["commit", "-m", "base extras"]);
  }
  const cell = join(root, `${name}-cell`);
  g(root, ["clone", "--quiet", origin, cell]);
  build.cell(cell);
  g(cell, ["add", "-A"]);
  g(cell, ["commit", "-m", "cell work"]);
  const shaper = join(root, `${name}-shaper`);
  g(root, ["clone", "--quiet", origin, shaper]);
  g(shaper, ["checkout", "--quiet", "-b", "landing"]);
  build.target(shaper);
  g(shaper, ["add", "-A"]);
  g(shaper, ["commit", "-m", "target work"]);
  g(shaper, ["push", "--quiet", "origin", "HEAD:refs/heads/landing"]);
  rmSync(shaper, { recursive: true, force: true });
  return {
    root,
    origin,
    cell,
    targetTip: g(origin, ["rev-parse", "refs/heads/landing"]),
    cellHead: g(cell, ["rev-parse", "HEAD"]),
  };
}

interface SideResult {
  report: CaptureReport;
  resultTree: string | null;
  resultParents: string | null;
  mergeTreeCalls: number;
  postRefs: string;
}

function originState(fx: Fixture): Record<string, string> {
  return {
    refs: g(fx.origin, ["for-each-ref"]),
    head: g(fx.origin, ["symbolic-ref", "HEAD"]),
    headSha: g(fx.origin, ["rev-parse", "HEAD"]),
    status: g(fx.origin, ["status", "--porcelain"]),
    cellHead: g(fx.cell, ["rev-parse", "HEAD"]),
    cellStatus: g(fx.cell, ["status", "--porcelain"]),
  };
}

function runSide(fx: Fixture, shim: Shim, opId: string): SideResult {
  const logBefore = readFileSync(shim.log, "utf8");
  let report: CaptureReport;
  withEnv({
    PATH: `${shim.dir}:${process.env.PATH ?? ""}`,
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE,
  }, () => {
    report = captureWork({
      originRepo: fx.origin,
      cellSpaceDir: fx.cell,
      targetBranch: "landing",
      mode: "merge",
      opId,
    });
  });
  const logLines = readFileSync(shim.log, "utf8").slice(logBefore.length).split("\n");
  const landed = report!.status === "landed" ? (report!.resultSha as string) : null;
  const result: SideResult = {
    report: report!,
    resultTree: landed ? g(fx.origin, ["rev-parse", `${landed}^{tree}`]) : null,
    resultParents: landed ? g(fx.origin, ["rev-parse", `${landed}^1`, `${landed}^2`]) : null,
    mergeTreeCalls: logLines.filter((line) => line === "merge-tree").length,
    postRefs: g(fx.origin, ["for-each-ref"]),
  };
  if (landed) {
    // Reset the target ref between calls (CAS on the landed sha), leaving the
    // fixture bit-identical for the other engine.
    g(fx.origin, ["update-ref", "refs/heads/landing", fx.targetTip, landed]);
  }
  return result;
}

/** Run both engines over one fixture and hold them to exact parity. */
function parity(fx: Fixture, shims: { object: Shim; fallback: Shim }, caseName: string): {
  object: SideResult;
  fallback: SideResult;
} {
  const before = originState(fx);
  const object = runSide(fx, shims.object, `parity-${caseName}-object`);
  assert.deepEqual(originState(fx), before, `${caseName}: object side must leave the fixture bit-identical`);
  const fallback = runSide(fx, shims.fallback, `parity-${caseName}-fallback`);
  assert.deepEqual(originState(fx), before, `${caseName}: fallback side must leave the fixture bit-identical`);

  assert.ok(object.mergeTreeCalls >= 1, `${caseName}: object side never attempted merge-tree`);
  assert.ok(fallback.mergeTreeCalls >= 1, `${caseName}: fallback shim never intercepted merge-tree`);
  assert.equal(g(fx.origin, ["for-each-ref", "refs/hive/"]), "", `${caseName}: transient ref must not survive`);

  // Tree first for readable divergence, then the full report (sha included:
  // pinned dates make byte-identical commits the parity bar for landed cases).
  assert.equal(fallback.resultTree, object.resultTree, `${caseName}: merge result TREES diverge between engines`);
  assert.equal(fallback.resultParents, object.resultParents, `${caseName}: merge result PARENTS diverge`);
  assert.deepEqual(fallback.report, object.report, `${caseName}: capture reports diverge between engines`);
  assert.equal(fallback.postRefs, object.postRefs, `${caseName}: post-capture ref sets diverge`);
  return { object, fallback };
}

test("parity: clean merges, attributes, renames, modes, gitlinks, conflicts, case collisions, and forced fallback", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hb-capture-parity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shims = {
    object: makeShim(root, "object-shim", false),
    fallback: makeShim(root, "fallback-shim", true),
  };

  // 1. disjoint-clean — the baseline differential and the explicit
  //    unsupported-fallback proof (the shim's rejection IS old-git behavior).
  {
    const fx = makeFixture(root, "disjoint", {
      target: (repo) => writeFileSync(join(repo, "target.txt"), "target\n"),
      cell: (repo) => writeFileSync(join(repo, "cell.txt"), "cell\n"),
    });
    const { object } = parity(fx, shims, "disjoint");
    assert.equal(object.report.status, "landed");
  }

  // 2. union merge attribute introduced on the TARGET side.
  {
    const fx = makeFixture(root, "attr-union-target", {
      base: (repo) => writeFileSync(join(repo, "list.txt"), "alpha\n"),
      target: (repo) => {
        writeFileSync(join(repo, ".gitattributes"), "list.txt merge=union\n");
        writeFileSync(join(repo, "list.txt"), "alpha\ntarget\n");
      },
      cell: (repo) => writeFileSync(join(repo, "list.txt"), "alpha\ncell\n"),
    });
    parity(fx, shims, "attr-union-target");
  }

  // 3. binary (-merge) attribute introduced on the CELL side, both sides
  //    modifying the file — the doc's flagged attribute-lookup divergence.
  {
    const fx = makeFixture(root, "attr-binary-cell", {
      base: (repo) => writeFileSync(join(repo, "blob.dat"), "v0\n"),
      target: (repo) => writeFileSync(join(repo, "blob.dat"), "v-target\n"),
      cell: (repo) => {
        writeFileSync(join(repo, ".gitattributes"), "blob.dat -merge\n");
        writeFileSync(join(repo, "blob.dat"), "v-cell\n");
      },
    });
    parity(fx, shims, "attr-binary-cell");
  }

  // 4. rename on the cell side + modify at the old path on the target side.
  {
    const fx = makeFixture(root, "rename-modify", {
      target: (repo) => writeFileSync(join(repo, "src", "app.ts"), "export const version = 2;\n"),
      cell: (repo) => g(repo, ["mv", "src/app.ts", "src/core.ts"]),
    });
    parity(fx, shims, "rename-modify");
  }

  // 5. delete/modify conflict — both engines must yield the same structured
  //    conflict report (the prototype falls back for conflicts by design).
  {
    const fx = makeFixture(root, "delete-modify", {
      target: (repo) => writeFileSync(join(repo, "README.md"), "# modified\n"),
      cell: (repo) => g(repo, ["rm", "--quiet", "README.md"]),
    });
    const { object } = parity(fx, shims, "delete-modify");
    assert.equal(object.report.status, "conflict");
    assert.ok(object.report.conflicts.includes("README.md"));
  }

  // 6. executable bit + symlink from the cell side.
  {
    const fx = makeFixture(root, "modes", {
      base: (repo) => writeFileSync(join(repo, "tool.sh"), "#!/bin/sh\nexit 0\n"),
      target: (repo) => writeFileSync(join(repo, "target.txt"), "t\n"),
      cell: (repo) => {
        chmodSync(join(repo, "tool.sh"), 0o755);
        symlinkSync("README.md", join(repo, "link.txt"));
      },
    });
    parity(fx, shims, "modes");
  }

  // 7. gitlink (submodule entry) added index-only on the cell side — bounded:
  //    no clone, the gitlink sha is the fixture's own base commit.
  {
    const fx = makeFixture(root, "gitlink", {
      target: (repo) => writeFileSync(join(repo, "target.txt"), "t\n"),
      cell: (repo) => {
        const base = g(repo, ["rev-parse", "HEAD"]);
        // An (empty) directory at the gitlink path keeps `git add -A` from
        // staging the entry's deletion; no real submodule clone is needed.
        mkdirSync(join(repo, "vendor", "sub"), { recursive: true });
        g(repo, ["update-index", "--add", "--cacheinfo", `160000,${base},vendor/sub`]);
        writeFileSync(join(repo, "cell-marker.txt"), "gitlink case\n");
      },
    });
    parity(fx, shims, "gitlink");
  }

  // 8. case collision: both sides add the same name in different case. The
  //    object engine never touches a filesystem; the fallback checks out on
  //    (likely case-insensitive) macOS APFS. Divergence here is a finding.
  {
    const fx = makeFixture(root, "case-collision", {
      target: (repo) => writeFileSync(join(repo, "Case.txt"), "target\n"),
      cell: (repo) => writeFileSync(join(repo, "case.txt"), "cell\n"),
    });
    parity(fx, shims, "case-collision");
  }
});
