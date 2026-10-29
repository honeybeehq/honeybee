import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellPrivateEnv } from "../../v2/driver-cell/src/cellState.ts";
import { gitEnv } from "../../v2/driver-cell/src/git.ts";
import { provisionCell } from "../../v2/driver-cell/src/provision.ts";
import { classifyIgnored, measureDirectoryBytes, sweepEvicting, trimCellWrapper } from "../../v2/driver-cell/src/retention.ts";

const files = Number(process.argv[2] ?? "4000");
const root = mkdtempSync(join(tmpdir(), "h1-park-fixture-"));
const hostTmp = tmpdir();
const g = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
const put = (dir: string, rel: string, content: string): void => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content);
};
const hostTmpEntries = (): number => readdirSync(hostTmp).length;
const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

try {
  const origin = join(root, "origin");
  mkdirSync(origin);
  g(origin, ["init", "-q", "-b", "main"]);
  put(origin, "README.md", "# fixture\n");
  put(origin, "src/app.ts", "export const version = 1;\n");
  put(origin, ".gitignore", "node_modules/\n.next/\n.proof/\n.env\n");
  g(origin, ["add", "-A"]);
  g(origin, ["commit", "-q", "-m", "initial"]);
  const sha = g(origin, ["rev-parse", "HEAD"]);
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot);
  const cell = provisionCell(cellsRoot, { beeId: "bee", originRepo: origin, sha, wrapper: "fixture", repoName: "repo", cellId: "c1" }, "op", { disableCow: true, useGitImages: false, sharedObjectsRoot: join(root, "cell-objects") });
  const space = cell.paths.spaceDir;
  const filler = "x".repeat(8 * 1024);
  for (let i = 0; i < files; i++) put(space, `node_modules/pkg-${i % 40}/lib/file-${i}.js`, filler);
  for (let i = 0; i < 200; i++) put(space, `.next/server/chunk-${i}.js`, filler);
  put(space, ".proof/shot.png", filler);
  put(space, ".env", "SECRET=1\n");
  put(space, "wip.txt", "uncommitted work\n");
  const env = cellPrivateEnv(cell.paths.wrapperDir, { privateTmpfs: false });
  const hostBefore = hostTmpEntries();
  for (let i = 0; i < 300; i++) put(env.TMPDIR, `leak-${i}/scratch.txt`, filler);
  const before = measureDirectoryBytes(cell.paths.wrapperDir);
  const gitBytes = measureDirectoryBytes(join(space, ".git"));
  const ignored = classifyIgnored(space, undefined, { purge: true });
  const parked = trimCellWrapper(cellsRoot, cell.paths.wrapperDir, ignored.trim, { purge: true });
  const swept = await sweepEvicting(cellsRoot);
  const after = measureDirectoryBytes(cell.paths.wrapperDir);
  const hostAfter = hostTmpEntries();
  const report = {
    files: { nodeModules: files, next: 200, tmpLeaks: 300 },
    copyMode: cell.copyMode,
    beforeBytes: before,
    afterBytes: after,
    gitBytes,
    reclaimedPercent: Math.round((1 - after / before) * 100),
    parked: parked.trimmed,
    skipped: parked.skipped,
    sweptDirs: swept.removed.length,
    trackedFilesUntouched: g(space, ["status", "--porcelain", "--untracked-files=no"]) === "",
    wipKept: existsSync(join(space, "wip.txt")),
    envKept: existsSync(join(space, ".env")),
    privateTmpGone: !existsSync(env.TMPDIR),
    hostTmpEntriesBefore: hostBefore,
    hostTmpEntriesAfter: hostAfter,
    alternates: existsSync(join(space, ".git", "objects", "info", "alternates")),
  };
  console.log(JSON.stringify(report, null, 2));
  console.log(`Cell ${mb(before)} MiB before park, ${mb(after)} MiB after (.git ${mb(gitBytes)} MiB); host tmp entries ${hostBefore} -> ${hostAfter}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
