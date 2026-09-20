import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore } from "../../core/src/index.ts";
import { makeDaemonDir, startDaemon } from "./helpers.ts";

test("central credential feature starts normally with a ready authority row", async () => {
  const rig = makeDaemonDir();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    const homePath = join(rig.dir, "homes", "claude-pilot");
    mkdirSync(homePath, { recursive: true });
    const expiresAt = Date.now() + 3_600_000;
    const document = { claudeAiOauth: { accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresAt } };
    const credential = JSON.stringify({ claudeAiOauth: { ...document.claudeAiOauth, refreshToken: "" } });
    writeFileSync(join(homePath, ".credentials.json"), credential, { mode: 0o600 });
    const authorityDir = join(rig.dir, "vault", ".credential-authorities");
    mkdirSync(authorityDir, { recursive: true });
    writeFileSync(join(authorityDir, "claude-pilot.json"), JSON.stringify({ generation: 1, operationKey: "feature-ready", document }), { mode: 0o600 });

    const store = openCoreStore(join(rig.dir, "core.sqlite3"), { ephemeral: true });
    store.createAccount({ id: "claude-pilot", harness: "claude", homePath, label: "pilot" });
    store.close();
    const seeded = new DatabaseSync(join(rig.dir, "core.sqlite3"));
    seeded.prepare(`INSERT INTO account_credential_authorities
      (account, phase, generation, expires_at, operation_key, updated_at)
      VALUES (?, 'ready', 1, ?, ?, ?)`).run("claude-pilot", expiresAt, "feature-ready", 1);
    seeded.close();

    daemon = await startDaemon(rig.dir);
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
});
