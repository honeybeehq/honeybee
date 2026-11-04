import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxEnvironment } from "../src/sandbox.ts";
import { cellDaemonEnvironment } from "../src/runtimeEnvironment.ts";

test("Cell package runner confirmation defaults remain explicit after environment layering", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-package-env-"));
  try {
    for (const sandboxed of [false, true]) {
      const incoming = cellDaemonEnvironment({npm_config_yes: "true", PATH: "/usr/bin:/bin"});
      if (sandboxed && process.platform === "darwin") {
        assert.throws(() => sandboxEnvironment(root, incoming, true), /unsupported on darwin/);
        continue;
      }
      const env = sandboxEnvironment(root, incoming, sandboxed);
      assert.equal(env.npm_config_yes, "false");
      assert.equal(env.npm_config_offline, undefined);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});
