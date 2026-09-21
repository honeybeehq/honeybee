import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalDigest } from "../src/comb/canonical.js";
import { prepareHoneybeeRelease } from "../src/release/prepare.js";

const hash = `sha256:${"a".repeat(64)}`;
function assessment(beforeRevision: string, afterRevision: string, version = "0.0.1", classification = "compatible-fix") {
  const identity = (sourceRevision: string) => ({ component: "honeybee", version, sourceRevision, target: "darwin-arm64", artifact: { url: "https://example.test/candidate.tgz", sha256: hash } });
  const before = identity(beforeRevision), after = identity(afterRevision);
  const probe = (value: ReturnType<typeof identity>) => ({ identity: value, inventorySha256: hash, passed: true, checks: ["candidate integration"], verifierSha256: hash });
  const body = { schemaVersion: 1, before, after, verification: { before: probe(before), after: probe(after) }, fingerprints: { before: hash, after: hash },
    evaluation: { evaluatorRevision: "b".repeat(40), modelRevision: "test-model", promptSha256: hash, policySha256: hash }, classification,
    bump: classification === "compatible-fix" ? "patch" : classification === "unverified" ? null : classification === "breaking-api" && !version.startsWith("0.") ? "major" : "minor",
    judgments: [], checks: [classification === "breaking-api" ? "incompatible" : classification === "unverified" ? "unverified" : "compatible"] };
  return { ...body, sha256: canonicalDigest(body) };
}
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "hon5-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git"), root = join(dir, "source");
  git(dir, "init", "--bare", remote); git(dir, "clone", remote, root);
  git(root, "config", "user.email", "test@example.test"); git(root, "config", "user.name", "Test");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "honeybee", version: "0.0.1" }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ name: "honeybee", version: "0.0.1", lockfileVersion: 3, packages: { "": { name: "honeybee", version: "0.0.1" } } }));
  await writeFile(join(root, "product.ts"), "export const product = 1;\n");
  git(root, "add", "."); git(root, "commit", "-m", "product"); git(root, "push", "origin", "HEAD:main");
  return { root, remote, revision: git(root, "rev-parse", "HEAD") };
}

test("release preparation freezes committed source and agrees package versions without editing checkout", async t => {
  const { root, revision } = await fixture(t);
  await writeFile(join(root, "product.ts"), "uncommitted work\n");
  const result = await prepareHoneybeeRelease({ repoRoot: root, sourceRevision: revision,
    assessment: assessment(revision, revision) });
  assert.equal(result.version, "0.0.2");
  assert.notEqual(result.sourceRevision, revision);
  assert.equal(git(root, "show", `${result.sourceRevision}:product.ts`), "export const product = 1;");
  assert.equal(JSON.parse(git(root, "show", `${result.sourceRevision}:package.json`)).version, "0.0.2");
  assert.equal(JSON.parse(git(root, "show", `${result.sourceRevision}:package-lock.json`)).packages[""].version, "0.0.2");
  assert.equal(git(root, "rev-parse", result.tag), result.sourceRevision);
  assert.equal(await readFile(join(root, "product.ts"), "utf8"), "uncommitted work\n");
});

test("concurrent requests and generated-metadata-only revisions reuse one durable allocation", async t => {
  const { root, revision } = await fixture(t);
  const request = { repoRoot: root, sourceRevision: revision, assessment: assessment(revision, revision) };
  const [first, second] = await Promise.all([prepareHoneybeeRelease(request), prepareHoneybeeRelease(request)]);
  assert.deepEqual(first, second);
  assert.equal(git(root, "ls-remote", "--refs", "origin", "refs/tags/honeybee-v*").split("\n").length, 1);
  assert.deepEqual(await prepareHoneybeeRelease({ ...request, sourceRevision: first.sourceRevision, assessment: null }), first);
});

test("changed source requires assessment against the reserved baseline and follows pre-1.0 breaking policy", async t => {
  const { root, revision } = await fixture(t);
  const first = await prepareHoneybeeRelease({ repoRoot: root, sourceRevision: revision, assessment: assessment(revision, revision) });
  await writeFile(join(root, "product.ts"), "export const product = 2;\n");
  git(root, "add", "."); git(root, "commit", "-m", "break API");
  const next = git(root, "rev-parse", "HEAD");
  await assert.rejects(prepareHoneybeeRelease({ repoRoot: root, sourceRevision: next, assessment: assessment(revision, next) }), /source\/base mismatch/);
  const second = await prepareHoneybeeRelease({ repoRoot: root, sourceRevision: next,
    assessment: assessment(first.sourceRevision, next, first.version, "breaking-api") });
  assert.equal(second.version, "0.1.0");
  assert.notEqual(second.productSourceSha256, first.productSourceSha256);
});

test("unverified or stale-source assessment cannot allocate a version", async t => {
  const { root, revision } = await fixture(t);
  await assert.rejects(prepareHoneybeeRelease({ repoRoot: root, sourceRevision: revision,
    assessment: assessment(revision, revision, "0.0.1", "unverified") }), /unverified/);
  await assert.rejects(prepareHoneybeeRelease({ repoRoot: root, sourceRevision: revision,
    assessment: assessment(revision, "f".repeat(40)) }), /source\/base mismatch/);
  assert.equal(git(root, "ls-remote", "--refs", "origin", "refs/tags/honeybee-v*"), "");
});
