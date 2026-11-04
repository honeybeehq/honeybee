import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HostGitRefused } from "../../../src/hostGitRuntime.ts";
import { gitEnv, hostGitEnv, tryGit } from "../src/git.ts";
import { provisionCell } from "../src/provision.ts";
import { deleteCell } from "../src/remove.ts";
import { g, makeRig } from "./helpers.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("host Git does not fetch missing objects implicitly through local transport", () => {
  const rig = makeRig();
  const previousMarker = process.env.HIVE_GIT_FIXTURE_MARKER;
  try {
    const cell = provisionCell(rig.cellsRoot, { beeId: "bee", originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: "bee", repoName: "fixture", cellId: "cell" }, "cmd", { disableCow: true });
    const space = cell.paths.spaceDir, marker = join(rig.root, "marker"), script = join(rig.root, "upload-pack"), remote = join(rig.root, "remote.git");
    process.env.HIVE_GIT_FIXTURE_MARKER = marker;
    writeFileSync(script, '#!/bin/sh\nprintf marker > "$HIVE_GIT_FIXTURE_MARKER"\nexit 1\n');
    chmodSync(script, 0o700);
    g(rig.root, ["init", "--bare", remote]);
    g(space, ["config", "remote.fixture.promisor", "true"]);
    g(space, ["config", "remote.fixture.url", remote]);
    g(space, ["config", "remote.fixture.uploadpack", quote(script)]);
    const head = join(space, ".git", "HEAD");
    writeFileSync(head, `${"a".repeat(40)}\n`);
    const before = readFileSync(head, "utf8");
    const baselineEnv = gitEnv();
    delete baselineEnv.GIT_NO_LAZY_FETCH;
    const baseline = spawnSync("git", ["rev-list", "HEAD"], { cwd: space, env: baselineEnv, encoding: "utf8", timeout: 10000 });
    assert.notEqual(baseline.status, 0);
    assert.equal(existsSync(marker), true);
    rmSync(marker);
    assert.throws(() => tryGit(space, ["rev-list", "HEAD"]), (error: unknown) => error instanceof HostGitRefused && error.reason === "missing_objects");
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(head, "utf8"), before);
    assert.throws(() => deleteCell(cell.paths.wrapperDir), HostGitRefused);
    assert.equal(existsSync(cell.paths.wrapperDir), true);
    assert.equal(existsSync(marker), false);
  } finally {
    if (previousMarker === undefined) delete process.env.HIVE_GIT_FIXTURE_MARKER;
    else process.env.HIVE_GIT_FIXTURE_MARKER = previousMarker;
    rig.cleanup();
  }
});

test("host Git pins object flags through wrappers and refuses unsupported versions", () => {
  const rig = makeRig();
  const previousPath = process.env.PATH;
  try {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = join(rig.root, "bin"), wrapper = join(bin, "git"), unexpected = join(rig.root, "unexpected");
    mkdirSync(bin);
    const writeWrapper = (version: string) => {
      writeFileSync(wrapper, `#!/bin/sh\n[ "$GIT_NO_LAZY_FETCH" = 1 ] && [ "$GIT_NO_REPLACE_OBJECTS" = 1 ] || exit 77\nif [ "$1" = --version ]; then printf 'git version ${version}\\n'; exit 0; fi\nprintf called > ${quote(unexpected)}\nGIT_SSH_COMMAND=false exec ${quote(realGit)} -c credential.helper=false "$@"\n`);
      chmodSync(wrapper, 0o700);
    };
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    writeWrapper("2.43.0");
    assert.throws(() => tryGit(rig.origin.repo, ["rev-list", "HEAD"]), (error: unknown) => error instanceof HostGitRefused && error.reason === "unsupported_version" && error.message.includes(">=2.44"));
    assert.equal(existsSync(unexpected), false);
    writeWrapper("2.44.0");
    assert.equal(tryGit(rig.origin.repo, ["rev-list", "HEAD"], { env: { GIT_NO_LAZY_FETCH: "0", GIT_NO_REPLACE_OBJECTS: "0" } }).status, 0);
    assert.equal(existsSync(unexpected), true);
    const env = hostGitEnv({ GIT_NO_LAZY_FETCH: "0", GIT_NO_REPLACE_OBJECTS: "0" });
    assert.equal(env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rig.cleanup();
  }
});
