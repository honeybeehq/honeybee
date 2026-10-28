import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assertCellGitSafe, cellGitEnv, CellGitSafetyError, configureCellGit } from "../src/gitSafety.ts";
import { provisionCell } from "../src/provision.ts";
import { g, makeRig } from "./helpers.ts";

test("Cell git safety fixture: hostile HOME, HTTPS origin, SSH output and typed refusal", () => {
  const rig = makeRig();
  const previousHome = process.env.HOME;
  try {
    const home = join(rig.root, "hostile-home");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), '[credential]\n\thelper = !gh auth git-credential\n[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n\tpushInsteadOf = git@github.com:\n');
    process.env.HOME = home;
    g(rig.origin.repo, ["remote", "set-url", "origin", "https://github.com/fixture/repo.git"]);
    const req = { beeId: "bee-safe", originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: "bee-safe", repoName: "fixture", cellId: "safe" };
    const cell = provisionCell(rig.cellsRoot, req, "fixture", { disableCow: true });
    const env = cellGitEnv({ ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "bad", GIT_CONFIG_PARAMETERS: "'credential.helper=bad'" });
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
    const cli = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: cell.paths.spaceDir, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      console.log(`$ git ${args.join(" ")}\n${result.stdout.trimEnd()}`);
      return result.stdout.trimEnd();
    };
    assert.equal(cli(["remote", "get-url", "origin"]), "git@github.com:fixture/repo.git");
    assert.equal(cli(["remote", "get-url", "--push", "origin"]), "git@github.com:fixture/repo.git");
    assert.match(cli(["config", "--show-origin", "--get-all", "credential.helper"]), /^file:\.git\/config\s*$/);
    assert.equal(cli(["ls-remote", "--get-url", "origin"]), "git@github.com:fixture/repo.git");
    assertCellGitSafe(cell.paths.spaceDir, env);
    assert.throws(() => assertCellGitSafe(cell.paths.spaceDir, { ...env, GIT_CONFIG_GLOBAL: join(home, ".gitconfig") }), { code: "cell_git_unsafe", reason: "credential_helper" });
    for (const [key, value, reason] of [
      ["remote.origin.pushurl", "https://github.com/fixture/repo.git", "origin"],
      ["credential.helper", "!gh auth git-credential", "credential_helper"],
      ["credential.https://github.com.helper", "!gh auth git-credential", "credential_helper"],
      ["url.https://github.com/.insteadOf", "git@github.com:", "url_rewrite"],
      ["url.https://github.com/.pushInsteadOf", "git@github.com:", "url_rewrite"],
    ]) {
      g(cell.paths.spaceDir, ["config", "--replace-all", key!, value!]);
      assert.throws(() => provisionCell(rig.cellsRoot, req, "replay", { disableCow: true }), (error: unknown) => {
        assert.ok(error instanceof CellGitSafetyError);
        assert.equal(error.reason, reason);
        console.log(`Tampered ${key}: ${error.code} (${error.reason})`);
        return true;
      });
      g(cell.paths.spaceDir, ["config", "--unset-all", key!]);
      if (key === "remote.origin.pushurl") g(cell.paths.spaceDir, ["config", key, "git@github.com:fixture/repo.git"]);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rig.cleanup();
  }
});


test("Cell git safety removes copied local/worktree rules and includes without changing included files", () => {
  const rig = makeRig();
  try {
    const repo = rig.origin.repo;
    const include = join(rig.root, "included.gitconfig");
    const content = '[credential "https://github.com"]\n\thelper = !gh auth git-credential\n[url "https://github.com/"]\n\tpushInsteadOf = git@github.com:\n';
    writeFileSync(include, content);
    g(repo, ["config", "include.path", include]);
    g(repo, ["config", "credential.helper", "bad"]);
    g(repo, ["config", "url.https://github.com/.insteadOf", "git@github.com:"]);
    g(repo, ["config", "extensions.worktreeConfig", "true"]);
    g(repo, ["config", "--worktree", "credential.helper", "bad"]);
    g(repo, ["config", "--worktree", "remote.origin.pushurl", "https://github.com/fixture/repo.git"]);
    g(repo, ["config", "--add", "remote.origin.pushurl", "https://github.com/fixture/other.git"]);
    configureCellGit(repo);
    assertCellGitSafe(repo, cellGitEnv(process.env));
    assert.equal(g(repo, ["remote", "get-url", "--push", "--all", "origin"]), "git@github.com:fixture/repo.git");
    assert.equal(readFileSync(include, "utf8"), content);
    g(repo, ["config", "--worktree", "credential.helper", "tampered"]);
    assert.throws(() => assertCellGitSafe(repo, cellGitEnv(process.env)), { code: "cell_git_unsafe", reason: "credential_helper" });
  } finally {
    rig.cleanup();
  }
});

test("Cell git safety provisions a linked-worktree origin without changing its shared config", () => {
  const rig = makeRig();
  try {
    const linked = join(rig.root, "linked-origin");
    g(rig.origin.repo, ["remote", "set-url", "origin", "https://github.com/fixture/linked.git"]);
    g(rig.origin.repo, ["worktree", "add", "--detach", linked, "HEAD"]);
    const before = readFileSync(join(rig.origin.repo, ".git", "config"), "utf8");
    const cell = provisionCell(rig.cellsRoot, { beeId: "bee-linked", originRepo: linked, sha: rig.origin.sha, wrapper: "bee-linked", repoName: "fixture", cellId: "linked" }, "linked", { disableCow: true });
    assertCellGitSafe(cell.paths.spaceDir, cellGitEnv(process.env));
    assert.equal(g(cell.paths.spaceDir, ["remote", "get-url", "--push", "origin"]), "git@github.com:fixture/linked.git");
    assert.equal(readFileSync(join(rig.origin.repo, ".git", "config"), "utf8"), before);
  } finally {
    rig.cleanup();
  }
});
