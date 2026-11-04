import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const entry = join(process.cwd(), "dist", "cli.js");
test("built CLI root and deploy help load without daemon startup or target state", { skip: !existsSync(entry) && "run npm run build first" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hb-built-deploy-help-"));
  try {
    for (const args of [["--help"], ["deploy", "--help"]]) {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [entry, ...args], {
        cwd: root,
        env: { HOME: join(root, "home"), HIVE_STORE_ROOT: join(root, "store"), HIVE_V2_DATA_DIR: join(root, "data"), NO_COLOR: "1", TERM: "dumb" },
        timeout: 10000,
      });
      assert.match(stdout, args[0] === "deploy" ? /Usage: hive deploy/ : /Usage/);
      assert.doesNotMatch(stderr, /Dynamic require|not supported/);
      assert.deepEqual(await readdir(root), []);
    }
  } finally {
    const trash = join(tmpdir(), "honeybee-test-trash");
    await mkdir(trash, { recursive: true, mode: 0o700 });
    await rename(root, join(trash, basename(root)));
  }
});
