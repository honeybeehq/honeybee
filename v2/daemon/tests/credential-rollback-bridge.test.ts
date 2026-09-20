import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore } from "../../core/src/index.ts";
import { makeDaemonDir, startDaemon } from "./helpers.ts";

const blockingPhases = ["enrolling", "ready", "refreshing", "uncertain", "disabling", "disabling_uncertain"] as const;

for (const phase of blockingPhases) {
  test(`v27 rollback bridge refuses daemon startup while credential authority is ${phase}`, async () => {
    const rig = makeDaemonDir();
    try {
      const homePath = join(rig.dir, "homes", "claude-pilot");
      mkdirSync(homePath, { recursive: true });
      const credentialPath = join(homePath, ".credentials.json");
      const credential = phase === "enrolling"
        ? JSON.stringify({ claudeAiOauth: { accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresAt: Date.now() - 1_000 } })
        : JSON.stringify({ claudeAiOauth: { accessToken: "access-fixture", refreshToken: "", expiresAt: Date.now() + 3_600_000 } });
      writeFileSync(credentialPath, credential, { mode: 0o600 });

      const store = openCoreStore(join(rig.dir, "core.sqlite3"), { ephemeral: true });
      store.createAccount({ id: "claude-pilot", harness: "claude", homePath, label: "pilot" });
      store.close();
      const seeded = new DatabaseSync(join(rig.dir, "core.sqlite3"));
      seeded.prepare(`INSERT INTO account_credential_authorities
        (account, phase, generation, expires_at, operation_key, updated_at)
        VALUES (?, ?, 1, ?, ?, ?)`).run("claude-pilot", phase, 9_999_999_999_999, `bridge-${phase}`, 1);
      seeded.close();

      await assert.rejects(
        () => startDaemon(rig.dir),
        new RegExp(`credential authority rollback blocked \\(claude-pilot:${phase}\\)`),
      );
      assert.equal(readFileSync(credentialPath, "utf8"), credential, "bridge must refuse before native credential handling");
    } finally {
      rig.cleanup();
    }
  });
}

test("v27 rollback bridge starts normally when every credential authority is disabled", async () => {
  const rig = makeDaemonDir();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    const homePath = join(rig.dir, "homes", "claude-pilot");
    mkdirSync(homePath, { recursive: true });
    const credential = JSON.stringify({ claudeAiOauth: { accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresAt: Date.now() + 3_600_000 } });
    writeFileSync(join(homePath, ".credentials.json"), credential, { mode: 0o600 });

    const store = openCoreStore(join(rig.dir, "core.sqlite3"), { ephemeral: true });
    store.createAccount({ id: "claude-pilot", harness: "claude", homePath, label: "pilot" });
    store.close();
    const seeded = new DatabaseSync(join(rig.dir, "core.sqlite3"));
    seeded.prepare(`INSERT INTO account_credential_authorities
      (account, phase, generation, expires_at, operation_key, updated_at)
      VALUES (?, 'disabled', 1, ?, ?, ?)`).run("claude-pilot", Date.now() + 3_600_000, "bridge-disabled", 1);
    seeded.close();

    daemon = await startDaemon(rig.dir);
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
});
