import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaledMs } from "../../core/tests/timeScale.ts";

test("host exit retains synthetic startup evidence before the first status drain", { timeout: scaledMs(60_000) }, async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--test", "--test-reporter=tap", "--import", fileURLToPath(new URL("./fixtures/hold-status-pump.mjs", import.meta.url)),
    "--test-name-pattern=the spawn booted is SYNTHETIC", fileURLToPath(new URL("./driver.test.ts", import.meta.url)),
  ], { timeout: scaledMs(45_000), env });
  assert.match(stdout, /pass 1/);
  assert.match(stdout, /fail 0/);
});
