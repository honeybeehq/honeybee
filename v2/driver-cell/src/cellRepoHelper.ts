import { spawnSync } from "node:child_process";
import { CELL_REPO_DIAGNOSTIC_BYTES, CELL_REPO_REPORT_BYTES, CELL_REPO_REQUEST_BYTES, CellRepoRefusal, parseCellRepoRequest, type CellRepoInspection } from "./cellRepoProtocol.ts";

export function inspectCellRepo(ignored: boolean, deadline: number): CellRepoInspection {
  const run = (args: string[]): string => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CellRepoRefusal("deadline");
    const result = spawnSync("/usr/bin/git", args, {
      cwd: "/cell", env: {
        PATH: "/usr/bin:/bin", HOME: "/scratch", TMPDIR: "/scratch",
        GIT_DIR: "/cell/.git", GIT_WORK_TREE: "/cell", GIT_CEILING_DIRECTORIES: "/cell",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "7",
        GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit",
        GIT_CONFIG_KEY_1: "gc.auto", GIT_CONFIG_VALUE_1: "0",
        GIT_CONFIG_KEY_2: "core.hooksPath", GIT_CONFIG_VALUE_2: "/dev/null",
        GIT_CONFIG_KEY_3: "core.fsmonitor", GIT_CONFIG_VALUE_3: "false",
        GIT_CONFIG_KEY_4: "submodule.recurse", GIT_CONFIG_VALUE_4: "false",
        GIT_CONFIG_KEY_5: "diff.ignoreSubmodules", GIT_CONFIG_VALUE_5: "all",
        GIT_CONFIG_KEY_6: "core.worktree", GIT_CONFIG_VALUE_6: "/cell",
        LC_ALL: "C",
      }, encoding: "utf8", timeout: remaining, maxBuffer: CELL_REPO_REPORT_BYTES,
    });
    if (result.error || result.signal || result.status !== 0) throw new CellRepoRefusal(result.error && "code" in result.error && result.error.code === "ETIMEDOUT" ? "deadline" : "git_failed");
    if (Buffer.byteLength(result.stderr ?? "") > CELL_REPO_DIAGNOSTIC_BYTES) throw new CellRepoRefusal("output_limit");
    return result.stdout;
  };
  const head = run(["--no-optional-locks", "rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const status = run(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--ignore-submodules=all", "--untracked-files=normal", ...(ignored ? ["--ignored=matching"] : [])]);
  const branches = run(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/"]).trimEnd().split("\n").filter(Boolean).map(line => {
    const [ref, sha] = line.split("\0");
    return { ref: ref!, sha: sha! };
  });
  const stashed = run(["show-ref", "--head"]).split("\n").some(line => line.endsWith(" refs/stash"));
  return { head, status, branches, stashed };
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > CELL_REPO_REQUEST_BYTES) process.exit(2);
});
process.stdin.on("end", () => {
  try {
    const request = parseCellRepoRequest(JSON.parse(input));
    const response = JSON.stringify(inspectCellRepo(request.ignored, Date.now() + 10_000));
    if (Buffer.byteLength(response) > CELL_REPO_REPORT_BYTES) throw new CellRepoRefusal("output_limit");
    process.stdout.write(response);
  } catch {
    process.exitCode = 2;
  }
});
