import { spawnSync } from "node:child_process";
import { CELL_REPO_DIAGNOSTIC_BYTES, CELL_REPO_STATUS_BYTES, CELL_REPO_REPORT_BYTES, CELL_REPO_REQUEST_BYTES, CellRepoRefusal, parseCellRepoRequest, type CellRepoInspection } from "./cellRepoProtocol.ts";

export function inspectCellRepo(ignored: boolean, deadline: number): Omit<CellRepoInspection, "status"> & { statusBase64: string } {
  const run = (args: string[], absent = false): Buffer => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CellRepoRefusal("deadline");
    const result = spawnSync("/usr/bin/git", args, {
      cwd: "/cell", env: {
        PATH: "/usr/bin:/bin", HOME: "/scratch", TMPDIR: "/scratch",
        GIT_DIR: "/cell/.git", GIT_WORK_TREE: "/cell", GIT_CEILING_DIRECTORIES: "/cell",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "19",
        GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit",
        GIT_CONFIG_KEY_1: "gc.auto", GIT_CONFIG_VALUE_1: "0",
        GIT_CONFIG_KEY_2: "core.hooksPath", GIT_CONFIG_VALUE_2: "/dev/null",
        GIT_CONFIG_KEY_3: "core.fsmonitor", GIT_CONFIG_VALUE_3: "false",
        GIT_CONFIG_KEY_4: "submodule.recurse", GIT_CONFIG_VALUE_4: "false",
        GIT_CONFIG_KEY_5: "diff.ignoreSubmodules", GIT_CONFIG_VALUE_5: "all",
        GIT_CONFIG_KEY_6: "core.worktree", GIT_CONFIG_VALUE_6: "/cell",
        GIT_CONFIG_KEY_7: "core.sshCommand", GIT_CONFIG_VALUE_7: "false",
        GIT_CONFIG_KEY_8: "core.pager", GIT_CONFIG_VALUE_8: "false",
        GIT_CONFIG_KEY_9: "core.editor", GIT_CONFIG_VALUE_9: "false",
        GIT_CONFIG_KEY_10: "diff.external", GIT_CONFIG_VALUE_10: "false",
        GIT_CONFIG_KEY_11: "core.attributesFile", GIT_CONFIG_VALUE_11: "/dev/null",
        GIT_CONFIG_KEY_12: "core.gitProxy", GIT_CONFIG_VALUE_12: "false",
        GIT_CONFIG_KEY_13: "core.askPass", GIT_CONFIG_VALUE_13: "false",
        GIT_CONFIG_KEY_14: "credential.helper", GIT_CONFIG_VALUE_14: "",
        GIT_CONFIG_KEY_15: "gpg.program", GIT_CONFIG_VALUE_15: "false",
        GIT_CONFIG_KEY_16: "gpg.ssh.program", GIT_CONFIG_VALUE_16: "false",
        GIT_CONFIG_KEY_17: "commit.gpgSign", GIT_CONFIG_VALUE_17: "false",
        GIT_CONFIG_KEY_18: "log.showSignature", GIT_CONFIG_VALUE_18: "false",
        GIT_ATTR_NOSYSTEM: "1", LC_ALL: "C",
      }, encoding: "buffer", timeout: remaining, maxBuffer: CELL_REPO_REPORT_BYTES,
    });
    if (result.error || result.signal || result.status !== 0 && !(absent && result.status === 1)) throw new CellRepoRefusal(result.error && "code" in result.error && result.error.code === "ETIMEDOUT" ? "deadline" : result.error && "code" in result.error && result.error.code === "ENOBUFS" ? "output_limit" : "git_failed");
    if (Buffer.byteLength(result.stderr ?? "") > CELL_REPO_DIAGNOSTIC_BYTES) throw new CellRepoRefusal("output_limit");
    return result.stdout;
  };
  const head = run(["--no-optional-locks", "rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim();
  const status = run(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--ignore-submodules=all", "--untracked-files=normal", ...(ignored ? ["--ignored=matching"] : [])]);
  const branches = run(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/" ]).toString("utf8").trimEnd().split("\n").filter(Boolean).map(line => {
    const [ref, sha] = line.split("\0");
    return { ref: ref!, sha: sha! };
  });
  const stashed = run(["rev-parse", "--verify", "--quiet", "refs/stash"], true).toString("utf8").trim().length > 0;
  if (status.length > CELL_REPO_STATUS_BYTES) throw new CellRepoRefusal("output_limit");
  return { head, statusBase64: status.toString("base64"), branches, stashed };
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
    const timeoutMs = Number(process.argv[2]);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new CellRepoRefusal("invalid_request");
    const response = JSON.stringify(inspectCellRepo(request.ignored, Date.now() + timeoutMs));
    if (Buffer.byteLength(response) > CELL_REPO_REPORT_BYTES) throw new CellRepoRefusal("output_limit");
    process.stdout.write(response);
  } catch (error) {
    process.stdout.write(JSON.stringify({ failure: error instanceof CellRepoRefusal ? error.code : "git_failed" }));
  }
});
