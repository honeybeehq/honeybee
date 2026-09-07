/**
 * The capture scratch clone must not hydrate source tags. Packed tag refs are
 * deliberately adversarial here: they exercise Git's implicit tag-following
 * path while the captures cover the object-only merge, checkout fallback,
 * and rebase engines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { captureWork, type CaptureMode, type CaptureReport } from "../src/capture.ts";
import { provisionCell } from "../src/provision.ts";
import { commitInCell, commitOn, fingerprintOrigin, fsckClean, g, makeRig } from "./helpers.ts";

const FIXED_DATE = "2026-09-07T00:00:00Z";
const TAG_LIGHTWEIGHT = "packed-lightweight";
const TAG_ANNOTATED = "packed-annotated";

interface PackedTagEvidence {
  lightweightCommit: string;
  annotatedCommit: string;
  annotatedTag: string;
}

interface Fixture {
  rig: ReturnType<typeof makeRig>;
  cellSpaceDir: string;
  targetTip: string;
  cellHead: string;
  tags: PackedTagEvidence | null;
}

interface CaseSpec {
  name: "clean-merge" | "checkout-conflict" | "rebase";
  mode: CaptureMode;
  conflict: boolean;
}

interface CaptureEvidence {
  report: CaptureReport;
  resultTree: string | null;
  resultParents: string[] | null;
  resultFiles: string[] | null;
}

function withEnv<T>(patch: Record<string, string>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function provisioned(rig: ReturnType<typeof makeRig>) {
  return provisionCell(
    rig.cellsRoot,
    {
      beeId: "bee-1",
      originRepo: rig.origin.repo,
      sha: rig.origin.sha,
      wrapper: "bee-1",
      repoName: "fixture",
      cellId: "c1",
    },
    "cmd-1",
    { disableCow: true },
  );
}

function seedPackedTags(origin: string): PackedTagEvidence {
  const tree = g(origin, ["rev-parse", "HEAD^{tree}"]);
  const lightweightCommit = g(origin, ["commit-tree", tree, "-m", "lightweight tag-only commit"]);
  const annotatedCommit = g(origin, ["commit-tree", tree, "-m", "annotated tag-only commit"]);
  g(origin, ["update-ref", `refs/tags/${TAG_LIGHTWEIGHT}`, lightweightCommit]);
  g(origin, ["tag", "-a", "-m", "annotated tag-only object", TAG_ANNOTATED, annotatedCommit]);
  const annotatedTag = g(origin, ["rev-parse", `refs/tags/${TAG_ANNOTATED}`]);
  g(origin, ["pack-refs", "--all", "--prune"]);
  const evidence = { lightweightCommit, annotatedCommit, annotatedTag };
  assertPackedTags(origin, evidence);
  return evidence;
}

function assertPackedTags(origin: string, evidence: PackedTagEvidence): void {
  const packed = readFileSync(join(origin, ".git", "packed-refs"), "utf8");
  assert.ok(packed.includes(`${evidence.lightweightCommit} refs/tags/${TAG_LIGHTWEIGHT}\n`));
  assert.ok(packed.includes(`${evidence.annotatedTag} refs/tags/${TAG_ANNOTATED}\n`));
  assert.ok(packed.includes(`^${evidence.annotatedCommit}\n`));
  assert.equal(existsSync(join(origin, ".git", "refs", "tags", TAG_LIGHTWEIGHT)), false);
  assert.equal(existsSync(join(origin, ".git", "refs", "tags", TAG_ANNOTATED)), false);
  assert.equal(
    g(origin, [
      "for-each-ref",
      "--format=%(refname)|%(objectname)|%(objecttype)|%(*objectname)",
      "refs/tags",
    ]),
    [
      `refs/tags/${TAG_ANNOTATED}|${evidence.annotatedTag}|tag|${evidence.annotatedCommit}`,
      `refs/tags/${TAG_LIGHTWEIGHT}|${evidence.lightweightCommit}|commit|`,
    ].join("\n"),
  );
}

function makeFixture(spec: CaseSpec, withTags: boolean): Fixture {
  const rig = makeRig();
  const cell = provisioned(rig);
  g(rig.origin.repo, ["checkout", "-b", "target"]);
  const targetTip = commitOn(
    rig.origin.repo,
    spec.conflict ? "clash.ts" : "origin-side.ts",
    spec.conflict ? "origin version\n" : "origin side\n",
    "target work",
  );
  g(rig.origin.repo, ["checkout", "main"]);
  const cellHead = commitInCell(
    cell.paths.spaceDir,
    spec.conflict ? "clash.ts" : "cell-side.ts",
    spec.conflict ? "cell version\n" : "cell side\n",
    "cell work",
  );
  return {
    rig,
    cellSpaceDir: cell.paths.spaceDir,
    targetTip,
    cellHead,
    tags: withTags ? seedPackedTags(rig.origin.repo) : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function traceArgvs(tracePath: string): string[][] {
  const argvs: string[][] = [];
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    if (line.length === 0) continue;
    const entry: unknown = JSON.parse(line);
    if (!isRecord(entry) || entry.event !== "start" || !Array.isArray(entry.argv)) continue;
    if (!entry.argv.every((arg): arg is string => typeof arg === "string")) continue;
    argvs.push(entry.argv);
  }
  return argvs;
}

function replaceTargetRef(refs: string, resultSha: string): string {
  let replaced = false;
  const expected = refs
    .split("\n")
    .map((line) => {
      if (!line.startsWith("refs/heads/target ")) return line;
      replaced = true;
      return `refs/heads/target ${resultSha}`;
    })
    .join("\n");
  assert.equal(replaced, true, "target ref missing from pre-capture fingerprint");
  return expected;
}

function assertScratchCloneTrace(fixture: Fixture, tracePath: string, spec: CaseSpec): void {
  const argvs = traceArgvs(tracePath);
  const clones = argvs.filter((argv) => argv[1] === "clone");
  assert.equal(clones.length, 1, `${spec.name}: expected exactly one scratch clone`);
  const clone = clones[0];
  assert.ok(clone);
  const executable = clone[0];
  assert.ok(executable);
  assert.equal(basename(executable), "git");
  assert.deepEqual(clone.slice(1, 6), ["clone", "--quiet", "--shared", "--no-checkout", "--no-tags"]);
  assert.equal(clone.length, 8);
  assert.equal(clone[6], fixture.rig.origin.repo);
  const destination = clone[7];
  assert.ok(destination);
  assert.equal(existsSync(dirname(destination)), false, `${spec.name}: scratch directory survived capture`);

  const commands = argvs.map((argv) => argv[1]);
  if (spec.mode === "merge") {
    assert.ok(commands.includes("merge-tree"), `${spec.name}: divergent merge skipped merge-tree`);
  }
  if (spec.name === "clean-merge") {
    assert.equal(commands.includes("checkout"), false, "clean merge unexpectedly used checkout fallback");
  } else {
    assert.ok(commands.includes("checkout"), `${spec.name}: scratch checkout not observed`);
    assert.ok(commands.includes(spec.mode), `${spec.name}: ${spec.mode} command not observed`);
  }
}

function runCapture(fixture: Fixture, spec: CaseSpec, traceName: string): CaptureEvidence {
  const originBefore = fingerprintOrigin(fixture.rig.origin.repo);
  const cellBefore = {
    head: g(fixture.cellSpaceDir, ["rev-parse", "HEAD"]),
    refs: g(fixture.cellSpaceDir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    status: g(fixture.cellSpaceDir, ["status", "--porcelain"]),
  };
  const tracePath = join(fixture.rig.root, traceName);
  writeFileSync(tracePath, "");
  const report = withEnv(
    {
      GIT_TRACE2_EVENT: tracePath,
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
    },
    () =>
      captureWork({
        originRepo: fixture.rig.origin.repo,
        cellSpaceDir: fixture.cellSpaceDir,
        targetBranch: "target",
        mode: spec.mode,
        opId: `packed-tags-${spec.name}`,
      }),
  );

  const expectedResultSha = spec.conflict
    ? null
    : g(fixture.rig.origin.repo, ["rev-parse", "refs/heads/target"]);
  const expectedReport: CaptureReport = spec.conflict
    ? {
        status: "conflict",
        targetBranch: "target",
        mode: spec.mode,
        cellHead: fixture.cellHead,
        baseTarget: fixture.targetTip,
        resultSha: null,
        conflicts: ["clash.ts"],
        reason: null,
      }
    : {
        status: "landed",
        targetBranch: "target",
        mode: spec.mode,
        cellHead: fixture.cellHead,
        baseTarget: fixture.targetTip,
        resultSha: expectedResultSha,
        conflicts: [],
        reason: null,
      };
  assert.deepEqual(report, expectedReport, `${spec.name}: exact capture report changed`);

  const originAfter = fingerprintOrigin(fixture.rig.origin.repo);
  if (report.status === "landed") {
    assert.ok(report.resultSha);
    assert.equal(g(fixture.rig.origin.repo, ["rev-parse", "refs/heads/target"]), report.resultSha);
    assert.deepEqual(originAfter, {
      ...originBefore,
      refs: replaceTargetRef(originBefore.refs, report.resultSha),
    });
  } else {
    assert.deepEqual(originAfter, originBefore, `${spec.name}: conflicted capture changed source state`);
  }
  assert.deepEqual(
    {
      head: g(fixture.cellSpaceDir, ["rev-parse", "HEAD"]),
      refs: g(fixture.cellSpaceDir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
      status: g(fixture.cellSpaceDir, ["status", "--porcelain"]),
    },
    cellBefore,
    `${spec.name}: capture changed cell refs, HEAD, or worktree`,
  );
  assert.equal(g(fixture.rig.origin.repo, ["for-each-ref", "--format=%(refname)", "refs/hive"]), "");
  assert.ok(fsckClean(fixture.rig.origin.repo));
  if (fixture.tags !== null) assertPackedTags(fixture.rig.origin.repo, fixture.tags);
  assertScratchCloneTrace(fixture, tracePath, spec);

  if (report.status !== "landed") {
    return { report, resultTree: null, resultParents: null, resultFiles: null };
  }
  const resultSha = report.resultSha;
  assert.ok(resultSha);
  const resultTree = g(fixture.rig.origin.repo, ["rev-parse", `${resultSha}^{tree}`]);
  const resultParents = g(fixture.rig.origin.repo, ["rev-list", "--parents", "-n", "1", resultSha])
    .split(" ")
    .slice(1);
  const resultFiles = g(fixture.rig.origin.repo, ["ls-tree", "-r", "--name-only", resultSha]).split("\n");
  const expectedParents = spec.mode === "merge" ? [fixture.targetTip, fixture.cellHead] : [fixture.targetTip];
  assert.deepEqual(resultParents, expectedParents, `${spec.name}: result parents changed`);
  assert.deepEqual(resultFiles, ["README.md", "cell-side.ts", "origin-side.ts", "src/app.ts"]);
  return { report, resultTree, resultParents, resultFiles };
}

test("shared no-tags clone keeps tag-only objects available by OID through its alternate", () => {
  const rig = makeRig();
  try {
    const tags = withEnv(
      { GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
      () => seedPackedTags(rig.origin.repo),
    );
    const scratch = join(rig.root, "direct-scratch");
    g(rig.root, ["clone", "--quiet", "--shared", "--no-checkout", "--no-tags", rig.origin.repo, scratch]);

    assert.equal(g(scratch, ["for-each-ref", "--format=%(refname)", "refs/tags"]), "");
    assert.equal(g(scratch, ["config", "--get", "remote.origin.tagOpt"]), "--no-tags");
    const alternate = readFileSync(join(scratch, ".git", "objects", "info", "alternates"), "utf8").trim();
    const originObjects = resolve(rig.origin.repo, g(rig.origin.repo, ["rev-parse", "--git-path", "objects"]));
    assert.equal(realpathSync(alternate), realpathSync(originObjects));

    assert.equal(g(scratch, ["cat-file", "-t", tags.lightweightCommit]), "commit");
    assert.equal(g(scratch, ["cat-file", "-t", tags.annotatedTag]), "tag");
    assert.equal(g(scratch, ["rev-parse", `${tags.annotatedTag}^{commit}`]), tags.annotatedCommit);
    for (const oid of [tags.lightweightCommit, tags.annotatedTag, tags.annotatedCommit]) {
      assert.equal(
        existsSync(join(scratch, ".git", "objects", oid.slice(0, 2), oid.slice(2))),
        false,
        `${oid}: tag object was copied instead of resolved through the alternate`,
      );
    }
  } finally {
    rig.cleanup();
  }
});

test("packed source tags do not change clean merge, checkout-conflict, or rebase capture semantics", () => {
  const cases: CaseSpec[] = [
    { name: "clean-merge", mode: "merge", conflict: false },
    { name: "checkout-conflict", mode: "merge", conflict: true },
    { name: "rebase", mode: "rebase", conflict: false },
  ];

  for (const spec of cases) {
    const control = withEnv(
      { GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
      () => makeFixture(spec, false),
    );
    const tagged = withEnv(
      { GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
      () => makeFixture(spec, true),
    );
    try {
      assert.equal(tagged.targetTip, control.targetTip, `${spec.name}: target fixture SHA drifted`);
      assert.equal(tagged.cellHead, control.cellHead, `${spec.name}: cell fixture SHA drifted`);
      const controlEvidence = runCapture(control, spec, `${spec.name}-control.trace2.jsonl`);
      const taggedEvidence = runCapture(tagged, spec, `${spec.name}-tagged.trace2.jsonl`);
      assert.deepEqual(taggedEvidence.report, controlEvidence.report, `${spec.name}: exact report differs with tags`);
      assert.equal(taggedEvidence.resultTree, controlEvidence.resultTree, `${spec.name}: result tree differs with tags`);
      assert.deepEqual(
        taggedEvidence.resultParents,
        controlEvidence.resultParents,
        `${spec.name}: result parents differ with tags`,
      );
      assert.deepEqual(taggedEvidence.resultFiles, controlEvidence.resultFiles, `${spec.name}: result files differ with tags`);
    } finally {
      control.rig.cleanup();
      tagged.rig.cleanup();
    }
  }
});
