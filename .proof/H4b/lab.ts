import assert from "node:assert/strict";
import fs, { mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.HOME!;
if (!root || root !== process.env.TMPDIR || !/^\/(?:private\/)?var\/tmp\//.test(root)) throw new Error("Isolated HOME == TMPDIR under /var/tmp required");
const doc = (chain: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: `FAKE-ACCESS-${chain}`, refreshToken: `FAKE-REFRESH-${chain}`, expiresAt } });
const [mode, scenario] = process.argv.slice(2);
const dir = join(root, process.env.H4B_RUN ?? "run", scenario ?? "none"), home = join(dir, "homes", "claude-lab"), vault = join(dir, "vault", "claude", "claude-lab");
const keychainFile = join(dir, "keychain-fixture.json"), ledger = join(dir, "calls.json");
const now = 200000;
let injected = false;
if (mode === "worker") {
  const rename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    rename(from, to);
    const target = String(to);
    if (!injected && ((scenario === "linux-crash" || scenario === "mac-home-crash" || scenario === "failed-home-crash") && target === join(home, ".credentials.json"))) {
      injected = true;
      process.exit(86);
    }
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
}
const { openCoreStore } = await import("../../v2/core/src/index.ts");
const { AccountsService } = await import("../../v2/daemon/src/accountsService.ts");
const { loadNodeConfig } = await import("../../v2/daemon/src/config.ts");
const setupService = (failing = false) => {
  const store = openCoreStore(join(dir, "core.sqlite3"));
  const account = store.getAccount("claude-lab")!;
  const service = new AccountsService({ store, cfg: loadNodeConfig(dir), now: () => now, platform: scenario.startsWith("linux") ? "linux" : "darwin", log: () => {},
    keychainReader: async () => existsSync(keychainFile) ? readFileSync(keychainFile, "utf8") : null,
    keychainWriter: async (_, raw) => {
      if (failing) return false;
      if (!existsSync(keychainFile)) return false;
      writeFileSync(keychainFile, raw);
      if (mode === "worker" && scenario === "mac-keychain-crash") process.exit(86);
      return true;
    },
    fetchers: {
      claudeUsage: async () => ({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }),
      claudeRefresh: async refresh => {
        const calls = JSON.parse(readFileSync(ledger, "utf8")) as { refreshes: number; spentSends: number };
        if (calls.refreshes > 0 && refresh === "FAKE-REFRESH-OLD") calls.spentSends++;
        calls.refreshes++;
        writeFileSync(ledger, JSON.stringify(calls));
        assert.equal(calls.spentSends, 0, "Spent fixture refresh must never be sent");
        return { kind: "success", token: { accessToken: "FAKE-ACCESS-NEW", refreshToken: "FAKE-REFRESH-NEW", expiresAt: 900000 } };
      },
    },
  });
  return { store, account, service };
};
if (mode === "worker") {
  const { store, account, service } = setupService(scenario.startsWith("failed"));
  try { await service.verifyCredentials(account); } finally { store.close(); }
} else if (mode !== "restart") {
  const scenarios = ["linux-normal", "linux-crash", "mac-keychain-crash", "mac-home-crash", "failed-restart", "failed-home-crash", "failed-login", "ambiguous-last-good"];
  for (const name of scenarios) {
    const caseDir = join(root, process.env.H4B_RUN ?? "run", name), caseHome = join(caseDir, "homes", "claude-lab"), caseVault = join(caseDir, "vault", "claude", "claude-lab");
    mkdirSync(caseHome, { recursive: true }); mkdirSync(caseVault, { recursive: true });
    writeFileSync(join(caseDir, "config.json"), JSON.stringify({ accounts: { homesDir: join(caseDir, "homes"), vaultDir: join(caseDir, "vault"), limitsRefreshMs: 0 } }));
    writeFileSync(join(caseHome, ".credentials.json"), doc("OLD", 1000));
    writeFileSync(join(caseVault, ".credentials.json"), doc("OLD", 1000));
    if (!name.startsWith("linux")) writeFileSync(join(caseDir, "keychain-fixture.json"), doc("OLD", 1000));
    writeFileSync(join(caseDir, "calls.json"), JSON.stringify({ refreshes: 0, spentSends: 0 }));
    const initial = openCoreStore(join(caseDir, "core.sqlite3"));
    initial.createAccount({ id: "claude-lab", harness: "claude", label: "fixture", homePath: caseHome, status: "ok" });
    if (name === "ambiguous-last-good") {
      initial.putAccountLimits("claude-lab", { readable: true, weeklyPct: 2 });
      const blank = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "FAKE-REFRESH-OTHER", expiresAt: 0 } });
      writeFileSync(join(caseDir, "keychain-fixture.json"), blank);
    }
    initial.close();
    const worker = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "worker", name], { env: process.env, encoding: "utf8" });
    const crash = name.endsWith("crash");
    assert.equal(worker.status, crash ? 86 : 0, worker.stderr);
    for (const lock of [".oauth_refresh.lock", ".storage-write.lock", "../claude-lab.lock"]) {
      const path = join(caseHome, lock);
      if (existsSync(path)) utimesSync(path, new Date(0), new Date(0));
    }
    const restart = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "restart", name], { env: process.env, encoding: "utf8" });
    assert.equal(restart.status, 0, restart.stderr);
    console.log(restart.stdout.trim());
  }
}
if (mode === "restart") {
  const { store, account, service } = setupService();
  try {
    const fenced = scenario.startsWith("failed");
    const ambiguous = scenario === "ambiguous-last-good";
    if (fenced || ambiguous) {
      assert.equal(store.accountCredentialAttention(account.id), fenced ? "keychain_publication_failed" : "live_chain_ambiguous");
      assert.equal(service.credentialReadiness(account).ready, false);
      assert.equal(service.mirrorRow(account).attention?.code, "credential_file_damaged");
      assert.equal(account.status, "ok");
      const before = JSON.parse(readFileSync(ledger, "utf8")).refreshes;
      await service.verifyCredentials(account);
      assert.equal(JSON.parse(readFileSync(ledger, "utf8")).refreshes, before);
      if (ambiguous) assert.equal(store.getAccountLimits(account.id)?.readable, true);
      else if (scenario === "failed-login") {
        await service.confirmClaudeLoginPublication(account, doc("NEW", 900000));
        assert.equal(store.accountCredentialAttention(account.id), "keychain_publication_failed");
        writeFileSync(keychainFile, doc("LOGIN", 1000000));
        writeFileSync(join(home, ".credentials.json"), doc("LOGIN", 1000000));
        const captured = service.persistCredentialCapture(account, ".credentials.json", doc("LOGIN", 1000000), { ".credentials.json": doc("LOGIN", 1000000) });
        assert.equal(captured.ok, true);
        await service.confirmClaudeLoginPublication(account, doc("LOGIN", 1000000));
        assert.equal(store.accountCredentialAttention(account.id), null);
        assert.equal(service.credentialReadiness(store.getAccount(account.id)!).ready, true);
      } else {
        await service.claudeKeychainRepairTick();
        assert.equal(store.accountCredentialAttention(account.id), null);
        assert.equal(service.credentialReadiness(store.getAccount(account.id)!).ready, true);
        assert.equal(readFileSync(keychainFile, "utf8"), readFileSync(join(home, ".credentials.json"), "utf8"));
        assert.equal(readFileSync(join(vault, ".credentials.json"), "utf8"), readFileSync(join(home, ".credentials.json"), "utf8"));
      }
    } else {
      await service.verifyCredentials(account);
      assert.equal(store.accountCredentialAttention(account.id), null);
      assert.equal(service.credentialReadiness(store.getAccount(account.id)!).ready, true);
    }
    const calls = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(calls.spentSends, 0);
    assert.equal(calls.refreshes, ambiguous ? 0 : 1);
    console.log(JSON.stringify({ scenario, ...calls, attention: service.mirrorRow(store.getAccount(account.id)!).attention?.code ?? null, ready: service.credentialReadiness(store.getAccount(account.id)!).ready, restart: true }));
  } finally { store.close(); }
}
