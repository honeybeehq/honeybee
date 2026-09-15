import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GatewayMcpSeedLockError, seedGatewayMcp } from "../../../src/accounts/gatewayMcpSeed.ts";
import { FileLockReleaseError, withFileLock } from "../../../src/lock.ts";
import { activationFailureName } from "../src/daemon.ts";

test("gateway lock timeout identifies the blocked stage safely, then the real seeder recovers", async () => {
  const home = await mkdtemp(join(tmpdir(), "hb-activation-private-home-"));
  const config = 'model = "fixture-private-model"\n';
  const options = {
    gateways: [{ name: "fixture", shim: { command: "/usr/bin/true", args: [] }, env: { PRIVATE: "fixture-secret" } }],
    failOnError: true,
  };
  try {
    await writeFile(join(home, "config.toml"), config);
    await withFileLock(join(home, ".hive-gateways.lock"), async () => {
      await assert.rejects(seedGatewayMcp(home, "codex", options), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "GatewayMcpSeedLockError");
        const diagnostic = activationFailureName(error);
        assert.match(diagnostic, /stage=gateway_mcp_lock operation=acquire code=FILE_LOCK_TIMEOUT/);
        assert.match(diagnostic, /timeoutMs=10000 waitMs=\d+ ownerPid=\d+/);
        assert.doesNotMatch(diagnostic, /private|fixture-secret|PRIVATE|config\.toml/);
        assert.equal(diagnostic.includes(home), false);
        return true;
      });
      assert.equal(await readFile(join(home, "config.toml"), "utf8"), config);
    });
    assert.equal((await seedGatewayMcp(home, "codex", options)).status, "seeded");
    assert.match(await readFile(join(home, "config.toml"), "utf8"), /\[mcp_servers.fixture\]/);
    assert.deepEqual((await seedGatewayMcp(home, "codex", options)).written, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("activation diagnostics never format arbitrary error text, names, or codes", () => {
  const error = Object.assign(new Error("fixture-secret message"), { name: "fixture-secret name", code: "fixture-secret code" });
  assert.equal(activationFailureName(error), "Error");
  assert.equal(activationFailureName("fixture-secret"), "unknown_error");
  assert.equal(activationFailureName(Object.assign(new Error("private"), { code: "EACCES" })), "Error(EACCES)");
  const releaseError = new GatewayMcpSeedLockError(new FileLockReleaseError({ cause: error }));
  assert.equal(activationFailureName(releaseError), "stage=gateway_mcp_lock operation=release code=FILE_LOCK_RELEASE_FAILED");
});
