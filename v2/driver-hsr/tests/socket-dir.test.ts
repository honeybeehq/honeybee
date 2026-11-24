import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketPathFits } from "../../core/src/socketPath.ts";
import { stubAdapter } from "../../adapters/src/index.ts";
import { RuntimeHost } from "../src/index.ts";
import { AGENT_PATH, drainUntil, ofKind } from "./helpers.ts";

function shortBase(): string {
  for (const base of [tmpdir(), "/tmp"]) {
    if (socketPathFits(join(base, "hb-v2-socket-dir-XXXXXX", "run", `hb-rh-${"0".repeat(16)}`, "stdin.sock"))) return base;
  }
  return tmpdir();
}

test("a runtime host given no socket folder keeps its runner sockets in run/ beside its runners, never in the shared temp folder", async () => {
  const dir = mkdtempSync(join(shortBase(), "hb-v2-socket-dir-"));
  const driver = new RuntimeHost({
    sessionLogDir: join(dir, "logs"),
    stopKillGraceMs: 400,
    resolve: () => ({ adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH], cwd: dir, env: { ...process.env, STUB_TURN_MS: "5" } }),
  });
  try {
    driver.start("bee-socket-dir", 1);
    await drainUntil(driver, (events) => ofKind(events, "booted").length > 0);
    const config = JSON.parse(readFileSync(join(dir, "runners", "bee-socket-dir.1.json"), "utf8")) as { socketPath: string };
    assert.ok(config.socketPath.startsWith(join(dir, "run") + "/"), `socket beside the runners: ${config.socketPath}`);
    assert.ok(existsSync(config.socketPath));
  } finally {
    driver.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
