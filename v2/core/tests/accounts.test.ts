import { knownAccountLease } from "../src/accountLease.ts";
/**
 * Schema v7 — accounts at the core tier (spec 08 tests 1, 9, 10 groundwork):
 * account CRUD (remove refused while referenced), status / penalty / login /
 * exhaustion edits, bee ↔ account binding ('auto' never stored), the env +
 * session rekey helpers swapAccount uses, limits snapshots, the per-harness
 * selection cursor, the v6 → v7 migration, audit replay for every new kind,
 * and the pure provider-response parsers. Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_CREDENTIAL_AUTHORITIES_TABLE_SQL } from "../src/schema.ts";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountNotFoundError,
  AccountReferencedError,
  CoreError,
  SCHEMA_VERSION,
  ACCOUNT_RECIPES,
  nativeAccountRecipe,
  accountConfigImportRecipeFor,
  accountIdFor,
  isAccountId,
  accountIsolationRefusal,
  defaultLoginMethodId,
  loginMethodsFor,
  offeredLoginMethods,
  homeEnvFor,
  isAuthFailureLimitsError,
  parseClaudeCredentials,
  parseClaudeUsage,
  parseMuseCredentials,
  parseMuseUsage,
  museQuotaLimits,
  parseCodexRateLimits,
  openCoreStore,
  recipeFor,
  recipeEnvFor,
  replayAudit,
  resolveVendorHome,
  safeName,
} from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

test("v7.recipes: the Claude recipe's CLI login is the native auth flow", () => {
  assert.deepEqual(recipeFor("claude")?.login, { command: "claude", args: ["auth", "login"] });
});

test("configuration onboarding has an explicit recipe only for the supported harnesses", () => {
  for (const harness of ["claude", "codex", "grok", "opencode", "kimi", "cursor"]) {
    assert.ok(accountConfigImportRecipeFor(harness)?.entries.length, harness);
  }
  assert.equal(accountConfigImportRecipeFor("agy"), undefined);
  assert.equal(accountConfigImportRecipeFor("stub"), undefined);
});

test("v7.recipes: the agy recipe conforms to the HOME-based Antigravity OAuth layout and captured login cues", () => {
  const recipe = recipeFor("agy");
  assert.ok(recipe);
  assert.deepEqual(recipe.credentialFiles, [".gemini/antigravity-cli/antigravity-oauth-token"]);
  assert.deepEqual(recipe.configFiles, [".gemini/antigravity/antigravity_state.pbtxt"]);
  assert.deepEqual(recipe.extraEnv, {
    HOME: "{home}",
    SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 1",
  });
  assert.equal(recipe.vendorHome.dir, ".gemini");
  assert.deepEqual(recipe.login, { command: "agy", args: [] });
  assert.equal(recipe.loginFlow.defaultMethodId, "agy-cli");
  assert.equal(recipe.loginFlow.methods.length, 1);
  const method = recipe.loginFlow.methods[0]!;
  assert.deepEqual(
    { id: method.id, kind: method.kind, remoteCapable: method.remoteCapable, fields: method.fields },
    { id: "agy-cli", kind: "browser_code", remoteCapable: true, fields: [] },
  );
  assert.equal(method.run.mode, "cli");
  if (method.run.mode !== "cli") return;
  assert.equal(method.run.cli.tty, true);
  assert.equal(method.run.cli.landing, "home_mtime");
  const authOutput = [
    "Authentication required. Please visit the URL to log in:",
    "  https://accounts.google.com/o/oauth2/auth?client_id=test",
    "",
    "Waiting for authentication (timeout 60s)...",
    "Or, paste the authorization code here and press Enter:",
  ].join("\n");
  const url = new RegExp(method.run.cli.cues.url ?? "", "i").exec(authOutput);
  assert.equal(url?.[1], "https://accounts.google.com/o/oauth2/auth?client_id=test");
  assert.ok(method.run.cli.cues.prompts.some((cue) => new RegExp(cue.match, "i").test(authOutput.split("\n").at(-1) ?? "")));
  assert.ok(method.run.cli.cues.failure?.some((cue) => new RegExp(cue, "i").test('{"error":"authentication failed or timed out"}')));
});

test("v7.recipes: the muse recipe isolates through the XDG pair and matches the captured `muse login` device output", () => {
  const recipe = recipeFor("muse");
  assert.ok(recipe);
  assert.equal(homeEnvFor("muse"), "XDG_CONFIG_HOME");
  assert.deepEqual(recipe.credentialFiles, ["muse/auth.json"]);
  assert.deepEqual(recipe.configFiles, ["muse/settings.json"]);
  assert.deepEqual(recipe.extraEnv, { XDG_DATA_HOME: "{home}/xdg-data" });
  assert.deepEqual(recipe.login, { command: "muse", args: ["login"] });
  assert.equal(recipe.loginFlow.defaultMethodId, "muse-device");
  const [device, oauth, apiKey] = recipe.loginFlow.methods;
  assert.deepEqual(
    { id: oauth?.id, kind: oauth?.kind, remoteCapable: oauth?.remoteCapable, fields: oauth?.fields, run: oauth?.run, harnessFree: oauth?.harnessFree },
    { id: "muse-oauth", kind: "device_code", remoteCapable: true, fields: [], run: { mode: "direct", runner: "muse_oauth" }, harnessFree: true },
  );
  assert.ok(recipe.loginFlow.methods.every((m) => m.id === "muse-oauth" || m.harnessFree === undefined), "only muse-oauth never starts muse");
  assert.deepEqual(
    { id: device?.id, kind: device?.kind, remoteCapable: device?.remoteCapable, fields: device?.fields },
    { id: "muse-device", kind: "device_code", remoteCapable: true, fields: [] },
  );
  assert.ok(device && device.run.mode === "cli");
  if (device.run.mode !== "cli") return;
  assert.equal(device.run.cli.tty, false);
  assert.equal(device.run.cli.landing, "home_mtime");
  assert.equal(device.run.cli.env?.MUSE_NO_AUTO_UPDATE, "1");
  const output = [
    "Open this page to sign in:",
    "  https://auth.meta.com/oauth/device/?code=DQZS-MPLT",
    "confirm this code matches:",
    "  DQZS-MPLT",
    "",
    "Waiting for approval…",
  ].join("\n");
  assert.equal(new RegExp(device.run.cli.cues.url ?? "", "i").exec(output)?.[1], "https://auth.meta.com/oauth/device/?code=DQZS-MPLT");
  const userCode = new RegExp(device.run.cli.cues.userCode ?? "", "i");
  assert.equal(userCode.exec(output.replace(/https?:\/\/\S+/g, " "))?.[1], "DQZS-MPLT");
  assert.equal(userCode.exec("and enter this code:\n  ABCD-EFGH")?.[1], "ABCD-EFGH");
  for (const line of ["The login request expired before it was approved.", "The login request was denied."]) {
    assert.ok(device.run.cli.cues.failure?.some((cue) => new RegExp(cue, "i").test(line)), line);
  }
  assert.ok(!device.run.cli.cues.failure?.some((cue) => new RegExp(cue, "i").test(output)));
  assert.deepEqual(
    { id: apiKey?.id, kind: apiKey?.kind, run: apiKey?.run, fields: apiKey?.fields.map((f) => [f.id, f.secret, f.inputType]) },
    { id: "muse-api-key", kind: "api_key", run: { mode: "direct", runner: "muse_api_key" }, fields: [["apiKey", true, "password"]] },
  );
});

test("v7.recipes: where a harness is unisolated only harness-free logins are offered, and the first of them is the default", () => {
  assert.deepEqual(offeredLoginMethods("muse", "darwin").map((m) => m.id), ["muse-oauth"]);
  assert.deepEqual(loginMethodsFor("muse", "darwin").map((m) => m.id), ["muse-oauth"]);
  assert.deepEqual(loginMethodsFor("muse", "linux").map((m) => m.id), ["muse-device", "muse-oauth", "muse-api-key"]);
  assert.deepEqual(loginMethodsFor("muse").map((m) => m.id), ["muse-device", "muse-oauth", "muse-api-key"], "no platform lists every method");
  assert.equal(defaultLoginMethodId("muse", { platform: "darwin" }), "muse-oauth");
  assert.equal(defaultLoginMethodId("muse", { platform: "darwin", remote: true }), "muse-oauth");
  assert.equal(defaultLoginMethodId("muse", { platform: "darwin", requested: "muse-device" }), null);
  assert.equal(defaultLoginMethodId("muse", { platform: "darwin", requested: "muse-api-key" }), null);
  assert.equal(defaultLoginMethodId("muse", { platform: "linux" }), "muse-device");
  assert.equal(defaultLoginMethodId("muse", { platform: "linux", remote: true }), "muse-device");
  assert.equal(defaultLoginMethodId("muse", { platform: "linux", requested: "muse-oauth" }), "muse-oauth");
  for (const harness of Object.keys(ACCOUNT_RECIPES)) {
    if (harness === "muse") continue;
    assert.deepEqual(loginMethodsFor(harness, "darwin"), loginMethodsFor(harness), `${harness} offers the same methods on darwin`);
    assert.equal(defaultLoginMethodId(harness, { platform: "darwin" }), ACCOUNT_RECIPES[harness]!.loginFlow.defaultMethodId, harness);
  }
});

test("v7.recipes: Muse accounts are unisolated on darwin only, where This Mac (the machine's own login) is the native account; no other recipe is", () => {
  assert.match(accountIsolationRefusal("muse", "darwin") ?? "", /^Muse keeps one login per macOS user in the Keychain, so Muse accounts can't be isolated on this Mac; use This Mac \(your own `muse login`\) or run Muse on a Linux node$/);
  assert.equal(accountIsolationRefusal("muse", "linux"), null);
  assert.deepEqual(nativeAccountRecipe("muse", "darwin"), {
    label: "This Mac",
    description: "This Mac: uses your own Muse sign-in (`muse login`) on this computer. Every Muse session on this Mac shares it. Honeybee never copies or changes it.",
    signIn: "Run `muse login` in Terminal on this Mac, then mark This Mac's account restored.",
    redirectEnv: ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "MUSE_PROJECTS_HOME", "MUSE_AUTH_PATH", "MUSE_LOGIN", "MUSE_NO_AUTO_UPDATE", "MUSE_SYNC_UPDATE", "MUSE_UPDATE_INTERVAL_SECONDS", "MUSE_CHANNEL", "TBH_CREDENTIAL_BACKEND", "META_API_KEY"],
  });
  assert.equal(nativeAccountRecipe("muse", "linux"), null);
  for (const harness of Object.keys(ACCOUNT_RECIPES)) {
    if (harness !== "muse") assert.equal(accountIsolationRefusal(harness, "darwin"), null, harness);
    if (harness !== "muse") assert.equal(nativeAccountRecipe(harness, "darwin"), null, harness);
  }
  assert.equal(accountIsolationRefusal("unknown", "darwin"), null);
  assert.equal(nativeAccountRecipe("unknown", "darwin"), null);
});

test("v7.recipes: parseMuseCredentials reads the meta entry's shape without returning tokens", () => {
  const doc = (meta: unknown) => JSON.stringify({ schema_version: 1, providers: { meta } });
  assert.deepEqual(parseMuseCredentials(doc({ api_key: "k-123" })), { mechanism: "api_key" });
  assert.deepEqual(parseMuseCredentials(doc({ mechanism: "oauth", access_token: "a", expires_at: 1_800_000_000, obtained_via: "device_code" })), { mechanism: "oauth", expiresAt: 1_800_000_000_000, refreshable: false });
  assert.deepEqual(parseMuseCredentials(doc({ mechanism: "oauth", access_token: "a", refresh_token: "r", expires_at: 1_800_000_000_123 })), { mechanism: "oauth", expiresAt: 1_800_000_000_123, refreshable: true });
  assert.deepEqual(parseMuseCredentials(doc({ mechanism: "oauth", access_token: "a" })), { mechanism: "oauth", expiresAt: null, refreshable: false });
  assert.deepEqual(parseMuseCredentials(doc({ mechanism: "oauth", obtained_via: "device_code", storage: "keychain", expires_at: 4102444800000 })), { mechanism: "keychain" });
  assert.equal(parseMuseCredentials(doc({ mechanism: "oauth", access_token: "" })), null);
  assert.equal(parseMuseCredentials(JSON.stringify({ schema_version: 1, providers: {} })), null);
  assert.equal(parseMuseCredentials("not json"), null);
  assert.equal(parseMuseCredentials(null), null);
});

/** Schema-shaped Muse MSP lines (validated against muse 1.4.7's exported schema; tier is a placeholder). */
const MUSE_USAGE_LINES = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters", "tests", "fixtures", "muse-usage-changed.jsonl"), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as { params: Record<string, any> });

test("v7.limits: parseMuseUsage maps the observed window and weekly block, preserves the opaque tier id as plan and dates the row by observedAtMs", () => {
  assert.deepEqual(parseMuseUsage(MUSE_USAGE_LINES[0]!.params), {
    readable: true,
    fetchedAt: 1791870000000,
    plan: "fixture-tier-from-provider",
    fiveHour: { usedPercent: 37, resetsAt: 1791880000000, windowMinutes: 300 },
    weekly: { usedPercent: 12, resetsAt: 1792300000000, windowMinutes: null },
  });
  // Over-quota percentages are verbatim provider data.
  assert.equal(parseMuseUsage(MUSE_USAGE_LINES[1]!.params)?.fiveHour?.usedPercent, 104);
  assert.deepEqual(parseMuseUsage({
    observedAtMs: 1791914092800,
    tier: "27681631238169137",
    window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791932002000 },
    weekly: { usedPercent: 12, resetsAtMs: 1792368000000 },
  }), {
    readable: true,
    fetchedAt: 1791914092800,
    plan: "27681631238169137",
    fiveHour: { usedPercent: 0, resetsAt: 1791932002000, windowMinutes: 300 },
    weekly: { usedPercent: 12, resetsAt: 1792368000000, windowMinutes: null },
  });
  // A window length is the provider's, never assumed.
  assert.equal(parseMuseUsage({ ...MUSE_USAGE_LINES[0]!.params, window: { usedPercent: 5, resetsAtMs: 1 } })?.fiveHour?.windowMinutes, null);
  assert.deepEqual(parseMuseUsage({ observedAtMs: 1, tier: "t", weekly: { usedPercent: 3, resetsAtMs: 9 } })?.weekly, { usedPercent: 3, resetsAt: 9, windowMinutes: null });
  // Nothing to record: no observation time, or no window with a percentage.
  assert.equal(parseMuseUsage({ tier: "t", window: { usedPercent: 1, resetsAtMs: 2, windowDurationMins: 3 } }), null);
  assert.equal(parseMuseUsage({ observedAtMs: 1, tier: "t" }), null);
  assert.equal(parseMuseUsage({ observedAtMs: 1, window: { usedPercent: Number.NaN } as never }), null);
});

test("v7.limits: museQuotaLimits marks the observed window whose reset the quota names as used up, and guesses nothing else", () => {
  const observed = {
    account: "muse-a", fetchedAt: 1791870000000, readable: true, unreadableReason: null, error: null, plan: "27681631238169137",
    fiveHourPct: 37, fiveHourResetsAt: 1791880000000, fiveHourMinutes: 300,
    weeklyPct: 12, weeklyResetsAt: 1792300000000, weeklyMinutes: null,
    fableWeeklyPct: null, fableResetsAt: null, fableMinutes: null, displayWindows: [], rateLimitResetCredits: null,
  };
  const quota = MUSE_USAGE_LINES[2]!.params.error.quota;
  assert.deepEqual(museQuotaLimits(observed, quota, 1791875000120), {
    readable: true,
    fetchedAt: 1791875000120,
    plan: "27681631238169137",
    fiveHour: { usedPercent: 100, resetsAt: 1791880000000, windowMinutes: 300 },
    weekly: { usedPercent: 12, resetsAt: 1792300000000, windowMinutes: null },
  });
  // The weekly reset (within a minute of skew) names the weekly block.
  assert.equal(museQuotaLimits(observed, { limitKind: "tierLimit", resetsAtMs: 1792300030000 }, 5)?.weekly?.usedPercent, 100);
  // Already over: the provider's own number stands.
  assert.equal(museQuotaLimits({ ...observed, fiveHourPct: 104 }, quota, 5)?.fiveHour?.usedPercent, 104);
  // No observed window with that reset, no observation, or no reset: no row change.
  assert.equal(museQuotaLimits(observed, { limitKind: "tierLimit", resetsAtMs: 1791000000000 }, 5), null);
  assert.equal(museQuotaLimits({ ...observed, readable: false }, quota, 5), null);
  assert.equal(museQuotaLimits(null, quota, 5), null);
  assert.equal(museQuotaLimits(observed, { limitKind: "tierLimit" }, 5), null);
});

test("v7.crud: create/get/list (registration order), remove; remove refused while a bee references it; replay", () => {
  const h = harness();
  try {
    const store = h.open();
    const a = store.createAccount({ id: "claude-a", harness: "claude", homePath: "/tmp/homes/claude-a", label: "a" });
    assert.equal(a.status, "ok");
    assert.equal(a.penalty, 0);
    assert.equal(a.lastLoginAt, null);
    const b = store.createAccount({ id: "claude-b", harness: "claude", homePath: "/tmp/homes/claude-b", label: "b", penalty: 10, status: "paused" });
    store.createAccount({ id: "codex-c", harness: "codex", homePath: "/tmp/homes/codex-c", label: "c", addedAt: 5 });
    assert.deepEqual(store.listAccounts().map((x) => x.id), ["codex-c", "claude-a", "claude-b"], "added_at then id");
    assert.deepEqual(store.listAccounts({ harness: "claude" }).map((x) => x.id), ["claude-a", "claude-b"]);
    assert.equal(store.getAccount("nope"), null);
    assert.throws(() => store.createAccount({ id: "claude-a", harness: "claude", homePath: "/x", label: "dup" }), /already exists/);
    assert.throws(() => store.createAccount({ id: "auto", harness: "claude", homePath: "/x", label: "auto" }), /reserved/);
    assert.throws(() => store.createAccount({ id: "claude-z", harness: "claude", homePath: "/x", label: "z", penalty: 101 }), /penalty/);
    assert.throws(() => store.createAccount({ id: "claude-z", harness: "claude", homePath: "/x", label: "z", status: "nope" as never }), /status/);

    // A bee on the account blocks removal (typed), until it is unbound.
    const { bee } = store.createBee({ name: "w", agent: "claude", substrate: "hsr", cwd: "/tmp", account: a.id });
    assert.equal(bee.account, a.id);
    assert.deepEqual(store.beesOnAccount(a.id).map((x) => x.id), [bee.id]);
    assert.throws(() => store.removeAccount(a.id), (err: unknown) => err instanceof AccountReferencedError && err.beeIds[0] === bee.id);
    assert.ok(store.getAccount(a.id), "refusal changed nothing");
    store.setBeeAccount(bee.id, null);
    const removed = store.removeAccount(a.id);
    assert.equal(removed.id, a.id);
    assert.equal(store.getAccount(a.id), null);
    assert.throws(() => store.removeAccount(a.id), AccountNotFoundError);
    // paused b stays; the codex one is untouched
    assert.equal(store.getAccount(b.id)?.status, "paused");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v7.edits: status/penalty/login/exhaustion/fields — audited as account.put updated with changed+previous; identical = no-op; replay", () => {
  const h = harness();
  try {
    const store = h.open();
    store.createAccount({ id: "codex-a", harness: "codex", homePath: "/tmp/a", label: "a" });
    assert.equal(store.setAccountStatus("codex-a", "auth_needed", "adapter: not logged in").applied, true);
    assert.equal(store.setAccountStatus("codex-a", "auth_needed").applied, false, "identical = silent");
    assert.equal(store.setAccountStatus("codex-a", "auth_needed", "adapter: not logged in").applied, false, "the same evidence = silent");
    assert.equal(store.getAccount("codex-a")?.statusReason, "adapter: not logged in");
    const restated = store.setAccountStatus("codex-a", "auth_needed", "provider refused the refresh token");
    assert.equal(restated.applied, true, "new evidence for auth_needed replaces the reason the operator acts on");
    assert.equal(restated.account.statusReason, "provider refused the refresh token");
    assert.equal(store.getAccount("codex-a")?.refreshTokenExpiresAt, null);
    assert.equal(store.setAccountRefreshTokenExpiry("codex-a", 4_000_000, "login").account.refreshTokenExpiresAt, 4_000_000);
    assert.equal(store.setAccountRefreshTokenExpiry("codex-a", 4_000_000, "login").applied, false, "identical = silent");
    assert.throws(() => store.setAccountRefreshTokenExpiry("codex-a", 1.5, "login"), CoreError);
    assert.equal(store.setAccountPenalty("codex-a", 25).applied, true);
    assert.throws(() => store.setAccountPenalty("codex-a", -1), CoreError);
    assert.throws(() => store.setAccountPenalty("codex-a", 100.5), CoreError);
    assert.equal(store.getAccount("codex-a")?.weeklyCeiling, null);
    assert.equal(store.setAccountWeeklyCeiling("codex-a", 60).account.weeklyCeiling, 60);
    assert.equal(store.setAccountWeeklyCeiling("codex-a", 60).applied, false, "identical = silent");
    for (const bad of [0, 101, 42.5, Number.NaN]) assert.throws(() => store.setAccountWeeklyCeiling("codex-a", bad), CoreError);
    assert.equal(store.setAccountWeeklyCeiling("codex-a", null).account.weeklyCeiling, null);
    // A completed login clears auth_needed and stamps last_login_at.
    const login = store.recordAccountLogin("codex-a", 777);
    assert.equal(login.account.status, "ok");
    assert.equal(login.account.lastLoginAt, 777);
    assert.equal(login.account.statusReason, "login completed");
    assert.equal(store.setAccountStatus("codex-a", "ok", "limits probe authenticated").applied, false, "ok restated stays silent");
    // …but never un-pauses a parked account.
    store.setAccountStatus("codex-a", "paused", "operator");
    assert.equal(store.recordAccountLogin("codex-a", 888).account.status, "paused");
    assert.equal(store.getAccount("codex-a")?.lastLoginAt, 888);
    assert.equal(store.recordAccountExhaustion("codex-a", 999).account.exhaustedAt, 999);
    assert.equal(store.recordAccountExhaustion("codex-a", null).account.exhaustedAt, null);
    assert.equal(store.updateAccountFields("codex-a", { label: "A", homePath: "/tmp/A" }).account.label, "A");
    assert.throws(() => store.updateAccountFields("codex-a", { label: "" }), CoreError);
    assert.throws(() => store.setAccountStatus("nope", "ok"), AccountNotFoundError);
    const puts = store.auditRows().filter((r) => r.kind === "account.put");
    assert.equal(puts[0]?.payload.outcome, "created");
    assert.equal(puts[1]?.payload.outcome, "updated");
    assert.deepEqual(puts[1]?.payload.changed, ["status", "statusReason"]);
    assert.deepEqual(puts[1]?.payload.previous, { status: "ok", statusReason: null });
    assert.equal(puts[1]?.payload.reason, "adapter: not logged in");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v33.pause: pause ownership — the holder is recorded, a foreign pause/unpause is refused unless forced, a bare paused status is an operator pause, and leaving paused clears the holder", () => {
  const h = harness();
  try {
    const store = h.open();
    store.createAccount({ id: "claude-a", harness: "claude", homePath: "/tmp/a", label: "a" });
    const byLease = store.pauseAccount("claude-a", { by: "lease", owner: "apiary:ws-1" });
    assert.equal(byLease.applied, true);
    assert.equal(byLease.heldBy, null);
    assert.deepEqual(
      (({ status, pausedBy, pausedOwner }) => ({ status, pausedBy, pausedOwner }))(byLease.account),
      { status: "paused", pausedBy: "lease", pausedOwner: "apiary:ws-1" },
    );
    assert.ok(byLease.account.pausedAt != null);
    // The same holder pausing again is a quiet no-op.
    const again = store.pauseAccount("claude-a", { by: "lease", owner: "apiary:ws-1" });
    assert.equal(again.applied, false);
    assert.equal(again.heldBy, null);
    // A different holder cannot take the pause silently…
    const operator = store.pauseAccount("claude-a", { by: "operator", owner: null });
    assert.equal(operator.applied, false);
    assert.deepEqual(operator.heldBy, { by: "lease", owner: "apiary:ws-1" });
    // …nor lift it.
    const foreignLift = store.unpauseAccount("claude-a", { by: "operator", owner: null }, "ok");
    assert.equal(foreignLift.applied, false);
    assert.deepEqual(foreignLift.heldBy, { by: "lease", owner: "apiary:ws-1" });
    assert.equal(store.getAccount("claude-a")?.status, "paused");
    // The holder lifts its own pause; the holder fields clear with the status.
    const lifted = store.unpauseAccount("claude-a", { by: "lease", owner: "apiary:ws-1" }, "auth_needed");
    assert.equal(lifted.applied, true);
    assert.deepEqual(
      (({ status, pausedBy, pausedOwner, pausedAt }) => ({ status, pausedBy, pausedOwner, pausedAt }))(lifted.account),
      { status: "auth_needed", pausedBy: null, pausedOwner: null, pausedAt: null },
    );
    assert.equal(store.unpauseAccount("claude-a", { by: "lease", owner: "apiary:ws-1" }, "ok").applied, false, "not paused = quiet");
    // force takes over / lifts a foreign pause.
    store.pauseAccount("claude-a", { by: "quota", owner: "weekly" });
    const taken = store.pauseAccount("claude-a", { by: "operator", owner: null }, { force: true });
    assert.equal(taken.applied, true);
    assert.equal(taken.account.pausedBy, "operator");
    assert.equal(store.unpauseAccount("claude-a", { by: "lease", owner: "x" }, "ok", { force: true }).account.status, "ok");
    // A bare `paused` status (legacy callers) is an operator pause; login never lifts it.
    store.setAccountStatus("claude-a", "paused", "legacy");
    assert.deepEqual(
      (({ pausedBy, pausedOwner }) => ({ pausedBy, pausedOwner }))(store.getAccount("claude-a")!),
      { pausedBy: "operator", pausedOwner: null },
    );
    assert.equal(store.recordAccountLogin("claude-a", 5).account.status, "paused");
    // Auth-health evidence never lifts a pause, however stale the caller's snapshot.
    assert.equal(store.setAccountStatus("claude-a", "ok").applied, false);
    assert.equal(store.setAccountStatus("claude-a", "auth_needed").applied, false);
    assert.equal(store.getAccount("claude-a")?.pausedBy, "operator");
    assert.equal(store.unpauseAccount("claude-a", { by: "operator", owner: null }, "ok").account.pausedBy, null);
    // Owner ids are validated: operator carries none, lease/quota require one.
    assert.throws(() => store.pauseAccount("claude-a", { by: "operator", owner: "nope" }), CoreError);
    assert.throws(() => store.pauseAccount("claude-a", { by: "lease", owner: "" }), CoreError);
    assert.throws(() => store.pauseAccount("claude-a", { by: "nobody" as "lease", owner: "x" }), CoreError);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v7.binding: setBeeAccount requires an existing account, never stores account selectors; setBeeEnv + rekeyBeeSession audit + replay", () => {
  const h = harness();
  try {
    const store = h.open();
    store.createAccount({ id: "claude-a", harness: "claude", homePath: "/tmp/a", label: "a" });
    store.createAccount({ id: "claude-b", harness: "claude", homePath: "/tmp/b", label: "b" });
    const { bee } = makeBee(store, "w");
    assert.equal(bee.account, null);
    assert.throws(() => store.createBee({ name: "x", agent: "claude", substrate: "hsr", cwd: "/tmp", account: "auto" }), /never a stored binding/);
    assert.throws(() => store.createBee({ name: "x", agent: "claude", substrate: "hsr", cwd: "/tmp", account: "rr" }), /never a stored binding/);
    assert.throws(() => store.createBee({ name: "x", agent: "claude", substrate: "hsr", cwd: "/tmp", account: "nope" }), AccountNotFoundError);
    assert.throws(() => store.setBeeAccount(bee.id, "auto"), CoreError);
    assert.throws(() => store.setBeeAccount(bee.id, "rr"), CoreError);
    assert.throws(() => store.setBeeAccount(bee.id, "nope"), AccountNotFoundError);
    const r1 = store.setBeeAccount(bee.id, "claude-a");
    assert.equal(r1.applied, true);
    assert.equal(r1.bee.account, "claude-a");
    assert.equal(store.setBeeAccount(bee.id, "claude-a").applied, false);
    const r2 = store.setBeeAccount(bee.id, "claude-b");
    assert.equal(r2.bee.account, "claude-b");
    const sets = store.auditRows().filter((r) => r.kind === "bee.account_set");
    assert.deepEqual(sets.map((r) => [r.payload.account, r.payload.previous]), [["claude-a", null], ["claude-b", "claude-a"]]);
    // env (the home mechanism)
    assert.equal(store.setBeeEnv(bee.id, { CLAUDE_CONFIG_DIR: "/tmp/b" }).applied, true);
    assert.equal(store.setBeeEnv(bee.id, { CLAUDE_CONFIG_DIR: "/tmp/b" }).applied, false);
    assert.deepEqual(store.getBee(bee.id)?.env, { CLAUDE_CONFIG_DIR: "/tmp/b" });
    assert.throws(() => store.setBeeEnv(bee.id, { X: 1 } as never), CoreError);
    // rekey (claude cross-account: resume the source under a NEW session via the fork seed)
    assert.equal(store.rekeyBeeSession(bee.id).applied, false, "nothing to rekey without a session");
    store.recordProviderSessionId(bee.id, "sid-1");
    const rekeyed = store.rekeyBeeSession(bee.id);
    assert.equal(rekeyed.applied, true);
    assert.equal(rekeyed.bee.forkSeed, "sid-1");
    assert.equal(rekeyed.bee.providerSessionId, null);
    // the fork's own id consumes the seed, like bee.fork
    store.recordProviderSessionId(bee.id, "sid-2");
    assert.equal(store.getBee(bee.id)?.forkSeed, null);
    assert.equal(store.getBee(bee.id)?.providerSessionId, "sid-2");
    // deleting the bee frees the account for removal
    store.deleteBee(bee.id);
    store.removeAccount("claude-b");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v7.limits+cursor: putAccountLimits replaces the one row per account (cascade on remove); selection cursor upserts; replay", () => {
  const h = harness();
  try {
    const store = h.open();
    store.createAccount({ id: "claude-a", harness: "claude", homePath: "/tmp/a", label: "a" });
    store.createAccount({ id: "claude-b", harness: "claude", homePath: "/tmp/b", label: "b" });
    assert.equal(store.getAccountLimits("claude-a"), null);
    const l1 = store.putAccountLimits("claude-a", {
      readable: true,
      plan: "max",
      fiveHour: { usedPercent: 3, resetsAt: 100, windowMinutes: 300 },
      weekly: { usedPercent: 40.5, resetsAt: 200, windowMinutes: 10_080 },
      fableWeekly: { usedPercent: 16, resetsAt: 200, windowMinutes: 10_080 },
      displayWindows: [
        { key: "cursor-models", label: "cursor models", usedPercent: 9, resetsAt: 300, windowMinutes: 43_200 },
      ],
      fetchedAt: 50,
    });
    assert.equal(l1.fetchedAt, 50);
    assert.equal(l1.weeklyPct, 40.5);
    assert.equal(l1.fableWeeklyPct, 16);
    assert.deepEqual(l1.displayWindows, [
      { key: "cursor-models", label: "cursor models", usedPercent: 9, resetsAt: 300, windowMinutes: 43_200 },
    ]);
    const l2 = store.putAccountLimits("claude-a", { readable: false, error: "HTTP 401 revoked" });
    assert.equal(l2.readable, false);
    assert.equal(l2.weeklyPct, null, "replaced, not merged");
    assert.deepEqual(l2.displayWindows, [], "display windows are replaced too");
    assert.equal(store.listAccountLimits().length, 1);
    assert.throws(() => store.putAccountLimits("nope", { readable: true }), AccountNotFoundError);
    // cursor
    assert.equal(store.getSelectionCursor("claude"), null);
    store.setSelectionCursor("claude", "claude-a");
    store.setSelectionCursor("claude", "claude-b");
    assert.equal(store.getSelectionCursor("claude")?.lastAccountId, "claude-b");
    assert.equal(store.listSelectionCursors().length, 1);
    // removing the account the cursor points at clears the cursor + cascades limits
    store.removeAccount("claude-b");
    assert.equal(store.getSelectionCursor("claude"), null);
    store.putAccountLimits("claude-a", { readable: true, weekly: { usedPercent: 1 } });
    store.removeAccount("claude-a");
    assert.deepEqual(store.listAccountLimits(), []);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v7.migration: a v6 store opens as v7 — bees.account added, accounts/account_limits/selection_cursors created, data intact, stamp bumped", () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '6');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
        provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
        spawn_failures INTEGER NOT NULL DEFAULT 0, args TEXT, parent_id TEXT, forked_from TEXT, fork_seed TEXT
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at, provider_session_id, env)
        VALUES('old-1','old','claude','hsr','/tmp','active',5,'sid-old','{"CLAUDE_CONFIG_DIR":"/tmp/homes/claude-x"}');
      CREATE TABLE runtimes (
        bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK (generation >= 1),
        state TEXT NOT NULL CHECK (state IN ('booting','running','idle','stopped')),
        exit_cause TEXT, pid INTEGER, pid_started_at INTEGER, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (bee_id, generation)
      ) STRICT;
      INSERT INTO runtimes(bee_id, generation, state, exit_cause, started_at, updated_at) VALUES('old-1', 1, 'stopped', 'clean', 5, 6);
    `);
    db.close();
    const store = h.open();
    const old = store.getBee("old-1");
    assert.equal(old?.account, null);
    assert.equal(old?.providerSessionId, "sid-old", "v3 data intact");
    assert.deepEqual(old?.env, { CLAUDE_CONFIG_DIR: "/tmp/homes/claude-x" });
    // the new tables work on the migrated store; binding the old bee works
    store.createAccount({ id: "claude-x", harness: "claude", homePath: "/tmp/homes/claude-x", label: "x" });
    assert.equal(store.setBeeAccount("old-1", "claude-x").applied, true);
    store.putAccountLimits("claude-x", { readable: true, weekly: { usedPercent: 2 } });
    store.setSelectionCursor("claude", "claude-x");
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      assert.equal(Number(version.value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 56);
      const cols = (check.prepare("SELECT name FROM pragma_table_info('bees')").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("account"));
      const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
      for (const t of ["accounts", "account_limits", "selection_cursors"]) assert.ok(tables.includes(t), t);
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});

test("v27 bridge reopens a disabled pilot store without losing ordinary state or authority metadata", () => {
  const h = harness();
  try {
    const feature = h.open();
    const account = feature.createAccount({
      id: "claude-pilot",
      harness: "claude",
      homePath: "/tmp/homes/claude-pilot",
      label: "pilot",
    });
    const { bee } = feature.createBee({
      name: "remembering-bee",
      agent: "claude",
      substrate: "hsr",
      cwd: "/tmp/work",
      account: account.id,
    });
    const message = feature.send(bee.id, "remember bridge state", { urgency: "idle" }).message;
    feature.close();

    // This is the exact secret-free row the feature leaves after a supported
    // disable. The bridge intentionally has no pilot methods; it must still
    // tolerate and preserve the feature-owned row while serving normal state.
    const seeded = new DatabaseSync(h.path);
    seeded.prepare(`INSERT INTO account_credential_authorities
      (account, phase, generation, expires_at, operation_key, updated_at)
      VALUES (?, 'disabled', 4, ?, ?, ?)`).run(account.id, 9_999_999, "rollout-4", 7_777);
    seeded.close();

    const bridge = h.open();
    assert.equal(bridge.getAccount(account.id)?.label, "pilot");
    assert.equal(bridge.getBee(bee.id)?.account, account.id);
    assert.equal(bridge.undeliveredMessages(bee.id)[0]?.id, message.id);
    assert.equal(bridge.undeliveredMessages(bee.id)[0]?.body, "remember bridge state");
    bridge.close();

    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      assert.deepEqual(
        { ...(check.prepare("SELECT phase, generation, expires_at, operation_key, updated_at FROM account_credential_authorities WHERE account = ?").get(account.id) as Record<string, unknown>) },
        { phase: "disabled", generation: 4, expires_at: 9_999_999, operation_key: "rollout-4", updated_at: 7_777 },
      );
      assert.equal((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});

test("v7.dump: StateDump carries accounts + limits + cursors; a fresh store's replay equals its dump", () => {
  const h = harness();
  try {
    const store = h.open();
    const dump = store.dumpState();
    assert.deepEqual(dump.accounts, []);
    assert.deepEqual(dump.accountLimits, []);
    assert.deepEqual(dump.selectionCursors, []);
    assert.deepEqual(dump.accountAdmissions, []);
    assert.deepEqual(replayAudit(store.auditRows()), dump);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v12+v13+v32 migration: account_limits gains typed failures and display windows, accounts gain a weekly ceiling, without inventing old data", () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '11');
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, harness TEXT NOT NULL, home_path TEXT NOT NULL, label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ok','auth_needed','paused')), penalty INTEGER NOT NULL DEFAULT 0,
        last_login_at INTEGER, exhausted_at INTEGER, added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO accounts VALUES('claude-old','claude','/tmp/claude-old','old','ok',0,NULL,NULL,1,1);
      INSERT INTO accounts VALUES('claude-parked','claude','/tmp/claude-parked','parked','paused',0,NULL,NULL,1,5);
      CREATE TABLE account_limits (
        account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        fetched_at INTEGER NOT NULL, readable INTEGER NOT NULL CHECK (readable IN (0,1)), error TEXT, plan TEXT,
        five_hour_pct REAL, five_hour_resets_at INTEGER, five_hour_minutes INTEGER,
        weekly_pct REAL, weekly_resets_at INTEGER, weekly_minutes INTEGER,
        fable_weekly_pct REAL, fable_resets_at INTEGER, fable_minutes INTEGER
      ) STRICT;
      INSERT INTO account_limits VALUES('claude-old',2,0,'old failure',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    `);
    db.close();
    const store = h.open();
    assert.equal(store.getAccountLimits("claude-old")?.unreadableReason, null);
    assert.equal(store.getAccountLimits("claude-old")?.rateLimitResetCredits, null);
    assert.equal(store.getAccount("claude-old")?.weeklyCeiling, null);
    assert.equal(store.getAccount("claude-old")?.pausedBy, null);
    // v33: a row paused before pause ownership existed is an operator pause stamped at its last update.
    assert.deepEqual(
      (({ pausedBy, pausedOwner, pausedAt }) => ({ pausedBy, pausedOwner, pausedAt }))(store.getAccount("claude-parked")!),
      { pausedBy: "operator", pausedOwner: null, pausedAt: 5 },
    );
    assert.equal(store.setAccountWeeklyCeiling("claude-old", 70).account.weeklyCeiling, 70);
    const refreshed = store.putAccountLimits("claude-old", {
      readable: false,
      unreadableReason: "auth_expired",
      error: "expired",
    });
    assert.equal(refreshed.unreadableReason, "auth_expired");
    // v18: the rebuilt CHECK accepts the refresh_deferred class on a migrated store
    const deferred = store.putAccountLimits("claude-old", {
      readable: false,
      unreadableReason: "refresh_deferred",
      error: "stood down to the live runtime",
    });
    assert.equal(deferred.unreadableReason, "refresh_deferred");
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const columns = (check.prepare("SELECT name FROM pragma_table_info('account_limits')").all() as Array<{ name: string }>).map((row) => row.name);
      assert.ok(columns.includes("unreadable_reason"));
      assert.ok(columns.includes("display_windows"));
      assert.ok(columns.includes("rate_limit_reset_credits"));
      const accountColumns = (check.prepare("SELECT name FROM pragma_table_info('accounts')").all() as Array<{ name: string }>).map((row) => row.name);
      assert.ok(accountColumns.includes("weekly_ceiling"));
      for (const column of ["paused_by", "paused_owner", "paused_at"]) assert.ok(accountColumns.includes(column), column);
      assert.equal((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});

test("v35 migration: a v34 store keeps its authority rows, gains login_required, the failure record and the login expiry", () => {
  const h = harness();
  try {
    const seeded = h.open();
    seeded.createAccount({ id: "claude-central", harness: "claude", homePath: "/tmp/claude-central", label: "central" });
    seeded.close();
    const db = new DatabaseSync(h.path);
    db.exec(`
      DROP TABLE account_credential_authorities;
      CREATE TABLE account_credential_authorities (
        account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        phase TEXT NOT NULL CHECK (phase IN ('enrolling','ready','refreshing','uncertain','disabling','disabling_uncertain','disabled')),
        generation INTEGER NOT NULL, expires_at INTEGER, operation_key TEXT, updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO account_credential_authorities VALUES('claude-central','uncertain',7,9999,'op-7',1234);
      ALTER TABLE accounts DROP COLUMN status_reason;
      ALTER TABLE accounts DROP COLUMN refresh_token_expires_at;
      UPDATE meta SET value = '34' WHERE key = 'schema_version';
    `);
    db.close();
    const store = h.open();
    assert.deepEqual(store.getAccountCredentialAuthority("claude-central"), {
      account: "claude-central", authorityInstanceId: store.getAccountCredentialAuthority("claude-central")!.authorityInstanceId, phase: "uncertain", generation: 7, expiresAt: 9999, operationKey: "op-7",
      refreshTokenExpiresAt: null, failure: null, updatedAt: 1234,
    });
    assert.equal(store.getAccount("claude-central")?.statusReason, null);
    assert.equal(store.getAccount("claude-central")?.refreshTokenExpiresAt, null);
    const failure = { outcome: "rejected" as const, httpStatus: 400, error: "invalid_grant", description: "Refresh token not found or invalid", at: 5, attempts: 1, retryAt: null };
    const terminal = store.putAccountCredentialAuthority({ account: "claude-central", phase: "login_required", generation: 7, expiresAt: 9999, operationKey: "op-8", refreshTokenExpiresAt: 77_000, failure });
    assert.deepEqual(store.getAccountCredentialAuthority("claude-central"), terminal);
    assert.deepEqual(terminal.failure, failure);
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      assert.equal((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
      assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name = 'account_credential_authorities_v34'").get(), undefined);
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// recipes + ids
// ---------------------------------------------------------------------------

test("v7.ids: accountIdFor follows the old registry rule (safeName, lower-case) — the operator's ids come across byte-identical", () => {
  assert.equal(accountIdFor("claude", "tormod@thto.no"), "claude-tormod-thto.no");
  assert.equal(accountIdFor("claude", "tormod.haugland@gmail.com"), "claude-tormod.haugland-gmail.com");
  assert.equal(accountIdFor("codex", " Codex Tormod Digitech "), "codex-codex-tormod-digitech");
  assert.equal(accountIdFor("kimi", "default"), "kimi-default");
  assert.equal(safeName("..."), "---");
  assert.deepEqual(recipeEnvFor("opencode", "/h"), { XDG_DATA_HOME: "/h/xdg-data" });
  assert.deepEqual(recipeEnvFor("agy", "/h"), {
    HOME: "/h",
    SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 1",
  });
  assert.deepEqual(recipeEnvFor("muse", "/h"), { XDG_DATA_HOME: "/h/xdg-data" });
  assert.deepEqual(recipeEnvFor("claude", "/h"), {});
});

// ---------------------------------------------------------------------------
// provider response parsing (ported from the old limits tests)
// ---------------------------------------------------------------------------

// old: "claude limits use the freshest unexpired token and map the usage windows" (mapping half)
//    + "claude limits map the Fable-scoped weekly entry to fableWeekly"
test("v7.parse.claude: five_hour/seven_day → windows with implied lengths; the Fable weekly_scoped entry → fableWeekly; no windows = unreadable", () => {
  const parsed = parseClaudeUsage({
    five_hour: { utilization: 12, resets_at: "2026-06-10T14:00:00Z" },
    seven_day: { utilization: 40, resets_at: "2026-06-15T00:00:00Z" },
    limits: [
      null,
      { kind: "session", percent: 12 },
      { kind: "weekly_scoped", percent: 66, resets_at: "2026-06-15T00:00:00Z", scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "Other" } } },
    ],
  }, "max");
  assert.deepEqual(parsed, {
    readable: true,
    plan: "max",
    fiveHour: { usedPercent: 12, windowMinutes: 300, resetsAt: Date.parse("2026-06-10T14:00:00Z") },
    weekly: { usedPercent: 40, windowMinutes: 10_080, resetsAt: Date.parse("2026-06-15T00:00:00Z") },
    fableWeekly: { usedPercent: 66, windowMinutes: 10_080, resetsAt: Date.parse("2026-06-15T00:00:00Z") },
  });
  const empty = parseClaudeUsage({ five_hour: { utilization: null }, seven_day: null });
  assert.equal(empty.readable, false);
  assert.match(empty.error ?? "", /no windows/);
  // a weekly-only answer is readable
  assert.equal(parseClaudeUsage({ seven_day: { utilization: 1 } }).readable, true);
});

// old: "codex keeps a weekly-only primary window out of the 5h column"
//    + "codex snapshot fallback classifies a weekly-only primary window by duration"
//    + "codex prefers live app-server limits" (mapping half)
test("v7.parse.codex: duration-classified windows win; a weekly-only primary stays out of the 5h column; positional fallback for duration-less windows", () => {
  const live = parseCodexRateLimits({
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_700_000_000 },
    secondary: { usedPercent: 55, windowDurationMins: 10_080, resetsAt: 1_700_500_000 },
    planType: "pro",
  });
  assert.deepEqual(live, {
    readable: true,
    plan: "pro",
    rateLimitResetCredits: null,
    fiveHour: { usedPercent: 20, resetsAt: 1_700_000_000_000, windowMinutes: 300 },
    weekly: { usedPercent: 55, resetsAt: 1_700_500_000_000, windowMinutes: 10_080 },
  });
  // Codex promotes the weekly window to `primary` when the 5h limit is disabled.
  const weeklyOnly = parseCodexRateLimits({ primary: { usedPercent: 33, windowDurationMins: 10_080 }, secondary: null });
  assert.equal(weeklyOnly.fiveHour, undefined);
  assert.equal(weeklyOnly.weekly?.usedPercent, 33);
  // No duration metadata → positional (primary = 5h, secondary = weekly).
  const positional = parseCodexRateLimits({ primary: { usedPercent: 1 }, secondary: { usedPercent: 2 } });
  assert.equal(positional.fiveHour?.usedPercent, 1);
  assert.equal(positional.weekly?.usedPercent, 2);
  // Mixed: a classified weekly primary + a duration-less secondary lands in the free (5h) slot.
  const mixed = parseCodexRateLimits({ primary: { usedPercent: 7, windowDurationMins: 10_080 }, secondary: { usedPercent: 9 } });
  assert.equal(mixed.weekly?.usedPercent, 7);
  assert.equal(mixed.fiveHour?.usedPercent, 9);
  assert.equal(parseCodexRateLimits({}).readable, false);
  assert.deepEqual(
    parseCodexRateLimits({ primary: { windowDurationMins: 300, resetsAt: 1_800_000_000 } }),
    { readable: false, rateLimitResetCredits: null, error: "app-server returned no rate-limit windows" },
    "missing utilization is uncertainty, never synthesized as zero use",
  );
});

test("v7.parse.claude-credentials + auth-failure classifier", () => {
  assert.equal(parseClaudeCredentials(null), null);
  assert.equal(parseClaudeCredentials("nope"), null);
  assert.equal(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "t" } })), null, "expiresAt required");
  assert.deepEqual(
    parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: 5, subscriptionType: "max", refreshToken: "r" } })),
    { accessToken: "t", expiresAt: 5, subscriptionType: "max", refreshToken: "r" },
  );
  assert.equal(isAuthFailureLimitsError("/api/oauth/usage: HTTP 401 — OAuth access token has been revoked"), true);
  assert.equal(isAuthFailureLimitsError("invalid_grant"), true);
  assert.equal(isAuthFailureLimitsError("HTTP 429 rate limited"), false);
  assert.equal(isAuthFailureLimitsError("fetch failed"), false);
});

// ---------------------------------------------------------------------------
// v18 — honest credentials: the vendor-home resolver + the re-publish touch
// ---------------------------------------------------------------------------

test("v18.vendorHome: the machine's real harness home — the home env var when set, else the recipe default under $HOME; relocated files per recipe; unknown harness = null", () => {
  const home = "/Users/op";
  // codex: CODEX_HOME wins; otherwise ~/.codex. config.toml rides along.
  const codexDefault = resolveVendorHome("codex", {}, home);
  assert.ok(codexDefault);
  assert.equal(codexDefault.homeEnv, "CODEX_HOME");
  assert.equal(codexDefault.fromEnv, false);
  assert.equal(codexDefault.vendorHome, "/Users/op/.codex");
  assert.deepEqual(codexDefault.files, [
    { rel: "auth.json", path: "/Users/op/.codex/auth.json", role: "credential" },
    { rel: "config.toml", path: "/Users/op/.codex/config.toml", role: "config" },
  ]);
  const codexEnv = resolveVendorHome("codex", { CODEX_HOME: "/srv/codex-home/" }, home);
  assert.equal(codexEnv?.fromEnv, true);
  assert.equal(codexEnv?.vendorHome, "/srv/codex-home/");
  assert.equal(codexEnv?.files[0]?.path, "/srv/codex-home/auth.json");
  assert.equal(resolveVendorHome("codex", { CODEX_HOME: "   " }, home)?.fromEnv, false, "a blank env var is unset");
  // claude: without CLAUDE_CONFIG_DIR `.claude.json` sits at $HOME; with it, everything is inside.
  const claudeDefault = resolveVendorHome("claude", {}, home);
  assert.deepEqual(claudeDefault?.files.map((f) => [f.rel, f.path]), [
    [".credentials.json", "/Users/op/.claude/.credentials.json"],
    [".claude.json", "/Users/op/.claude.json"],
    ["settings.json", "/Users/op/.claude/settings.json"],
  ]);
  const claudeEnv = resolveVendorHome("claude", { CLAUDE_CONFIG_DIR: "/Users/op/.claude-2" }, home);
  assert.deepEqual(claudeEnv?.files.map((f) => f.path), ["/Users/op/.claude-2/.credentials.json", "/Users/op/.claude-2/.claude.json", "/Users/op/.claude-2/settings.json"]);
  // opencode: the auth store is ALWAYS under XDG data, never in the config dir.
  const oc = resolveVendorHome("opencode", {}, home);
  assert.equal(oc?.vendorHome, "/Users/op/.config/opencode");
  assert.equal(oc?.files[0]?.path, "/Users/op/.local/share/opencode/auth.json");
  assert.equal(oc?.files[1]?.path, "/Users/op/.config/opencode/opencode.json");
  const ocXdg = resolveVendorHome("opencode", { XDG_DATA_HOME: "/data", OPENCODE_CONFIG_DIR: "/cfg/oc" }, home);
  assert.equal(ocXdg?.files[0]?.path, "/data/opencode/auth.json");
  assert.equal(ocXdg?.files[1]?.path, "/cfg/oc/opencode.json");
  const agy = resolveVendorHome("agy", {}, home);
  assert.equal(agy?.homeEnv, undefined);
  assert.equal(agy?.fromEnv, false);
  assert.equal(agy?.vendorHome, "/Users/op/.gemini");
  assert.deepEqual(agy?.files, [
    { rel: ".gemini/antigravity-cli/antigravity-oauth-token", path: "/Users/op/.gemini/antigravity-cli/antigravity-oauth-token", role: "credential" },
    { rel: ".gemini/antigravity/antigravity_state.pbtxt", path: "/Users/op/.gemini/antigravity/antigravity_state.pbtxt", role: "config" },
  ]);
  // muse: the config root is $XDG_CONFIG_HOME/muse, else ~/.config/muse.
  const muse = resolveVendorHome("muse", {}, home);
  assert.equal(muse?.homeEnv, "XDG_CONFIG_HOME");
  assert.equal(muse?.fromEnv, false);
  assert.deepEqual(muse?.files, [
    { rel: "muse/auth.json", path: "/Users/op/.config/muse/auth.json", role: "credential" },
    { rel: "muse/settings.json", path: "/Users/op/.config/muse/settings.json", role: "config" },
  ]);
  assert.equal(resolveVendorHome("muse", { XDG_CONFIG_HOME: "/cfg" }, home)?.files[0]?.path, "/cfg/muse/auth.json");
  // every recipe declares a vendor home (the import path covers all of them)
  for (const harness of ["claude", "codex", "opencode", "grok", "kimi", "agy", "muse", "cursor"]) {
    assert.ok(resolveVendorHome(harness, {}, home)?.files[0]?.role === "credential", harness);
  }
  assert.equal(resolveVendorHome("stub", {}, home), null);
});

test("v18.touchAccount: re-publishes the row (account.put) with an honest `changed` — [] under a frozen clock, [updatedAt] once time moved", () => {
  const h = harness();
  try {
    let t = 1_000_000;
    const store = openCoreStore(h.path, { now: () => t, ephemeral: true });
    const a = store.createAccount({ id: "codex-t", harness: "codex", homePath: "/tmp/homes/codex-t", label: "t" });
    const before = store.lastAuditSeq();
    const frozen = store.touchAccount(a.id, "credential health unverified → verified by limits probe");
    assert.equal(frozen.account.updatedAt, a.updatedAt);
    const rows = store.auditRows(before);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, "account.put");
    assert.deepEqual(Object.keys(rows[0]?.payload ?? {}).sort(), ["account", "changed", "outcome", "previous", "reason"]);
    assert.deepEqual(rows[0]?.payload.changed, []);
    assert.equal(rows[0]?.payload.reason, "credential health unverified → verified by limits probe");
    t += 1000;
    const moved = store.touchAccount(a.id, "again");
    assert.equal(moved.account.updatedAt, a.updatedAt + 1000);
    const last = store.auditRows(before + 1)[0];
    assert.deepEqual(last?.payload.changed, ["updatedAt"]);
    assert.deepEqual(last?.payload.previous, { updatedAt: a.updatedAt });
    // the replayed store agrees with the live one
    assert.equal(replayAudit(store.auditRows()).accounts.find((row) => row.id === a.id)?.updatedAt, a.updatedAt + 1000);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v36 migrates native accounts as local without credential material", () => {
  const h = harness();
  try {
    const store = h.open();
    store.createAccount({ id: "claude-native", harness: "claude", homePath: "/tmp/native-home", label: "native" });
    store.close();
    const old = new DatabaseSync(h.path);
    old.exec("ALTER TABLE accounts DROP COLUMN source; ALTER TABLE accounts DROP COLUMN leased_from; UPDATE meta SET value = '35' WHERE key = 'schema_version'");
    old.close();
    const migrated = h.open();
    assert.equal(migrated.getAccount("claude-native")?.source, "local");
    assert.equal(knownAccountLease(migrated.getAccount("claude-native")), null);
    migrated.close();
  } finally { h.cleanup(); }
});


test("v37 migrates ended lease metadata to revoked without losing account or bee references", () => {
  const h = harness();
  try {
    const initial = h.open();
    const account = initial.createAccount({ id: "claude-migration-test", harness: "claude", homePath: "/tmp/migration-test", label: "migration-test" });
    const { bee } = initial.createBee({ name: "migration-bee", agent: "claude", substrate: "hsr", cwd: "/tmp/work", account: account.id });
    initial.close();
    const db = new DatabaseSync(h.path);
    db.prepare("UPDATE accounts SET source = 'leased', leased_from = ? WHERE id = ?").run(JSON.stringify({ shareId: "test-share", authorityNodeId: "test-node", epoch: 1, expiresAt: null, adoptedAt: null, endedAt: 1234 }), account.id);
    db.prepare("UPDATE meta SET value = '36' WHERE key = 'schema_version'").run();
    db.close();
    const migrated = h.open();
    const row = migrated.getAccount(account.id)!;
    assert.equal(row.source, "leased");
    assert.equal(knownAccountLease(row)?.revokedAt, 1234);
    assert.equal("endedAt" in knownAccountLease(row)!, false);
    assert.equal(migrated.getBee(bee.id)?.account, account.id);
    assert.throws(() => migrated.removeAccount(account.id), AccountReferencedError);
    migrated.close();
  } finally { h.cleanup(); }
});

test("v37 credential authority migrates to the handoff phase CHECK without losing expiry or failure metadata", () => {
  const h = harness();
  try {
    const store = h.open();
    store.createAccount({ id: "codex-test-example.com", harness: "codex", label: "test-example.com", homePath: "/tmp/owned-test-home" });
    const state = store.putAccountCredentialAuthority({ account: "codex-test-example.com", phase: "ready", generation: 4, expiresAt: 100000, operationKey: "fixture-operation", refreshTokenExpiresAt: 200000,
      failure: { outcome: "retryable", httpStatus: 429, error: null, description: "rate limited", at: 10, attempts: 1, retryAt: 100 } });
    store.close();
    const old = new DatabaseSync(h.path);
    old.exec("ALTER TABLE account_credential_authorities RENAME TO authority_v38_fixture");
    old.exec(ACCOUNT_CREDENTIAL_AUTHORITIES_TABLE_SQL.replace(",'handing_off','adopting'", ""));
    old.exec("INSERT INTO account_credential_authorities SELECT * FROM authority_v38_fixture");
    old.exec("DROP TABLE authority_v38_fixture; DROP TABLE credential_handoffs; DROP TABLE credential_handoff_events; DROP TABLE credential_authority_epochs");
    old.prepare("UPDATE meta SET value = '37' WHERE key = 'schema_version'").run();
    old.close();
    const migrated = h.open();
    assert.deepEqual(migrated.getAccountCredentialAuthority(state.account), state);
    assert.equal(migrated.getCredentialHandoff("absent", "source"), null);
    assert.equal(migrated.putAccountCredentialAuthority({ ...state, phase: "handing_off" }).phase, "handing_off");
    assert.equal(migrated.putAccountCredentialAuthority({ ...state, phase: "adopting" }).phase, "adopting");
    migrated.close();
  } finally { h.cleanup(); }
});

test("v38 store gains the persisted native marker; one native account per harness is enforced by the store", () => {
  const h = harness();
  try {
    const initial = h.open();
    initial.createAccount({ id: "muse-old", harness: "muse", homePath: "/tmp/native-test-home", label: "old" });
    initial.close();
    const db = new DatabaseSync(h.path);
    db.exec("DROP INDEX accounts_native_harness");
    db.exec("ALTER TABLE accounts DROP COLUMN native");
    db.prepare("UPDATE meta SET value = '38' WHERE key = 'schema_version'").run();
    db.close();
    const store = h.open();
    assert.equal(store.getAccount("muse-old")!.native, false);
    assert.equal(store.nativeAccount("muse"), null);
    const native = store.createAccount({ id: "muse-this-mac", harness: "muse", homePath: "/tmp/native-test-home", label: "This Mac", native: true });
    assert.equal(native.native, true);
    assert.equal(store.nativeAccount("muse")!.id, "muse-this-mac");
    assert.throws(() => store.createAccount({ id: "muse-second", harness: "muse", homePath: "/tmp/native-test-home", label: "second", native: true }), /muse already has its native account: muse-this-mac/);
    assert.equal(store.getAccount("muse-second"), null);
    assert.equal(store.createAccount({ id: "codex-native", harness: "codex", homePath: "/tmp/codex-native", label: "native", native: true }).native, true);
    assert.throws(() => store.updateAccountFields("muse-this-mac", { homePath: "/tmp/elsewhere" }), /native account; its home is the machine's own/);
    assert.equal(store.updateAccountFields("muse-this-mac", { label: "Studio" }).account.native, true);
    store.close();
    const raw = new DatabaseSync(h.path);
    assert.throws(() => raw.prepare("UPDATE accounts SET native = 1 WHERE id = 'muse-old'").run(), /UNIQUE/);
    raw.close();
    const reopened = h.open();
    assert.equal(reopened.getAccount("muse-this-mac")!.native, true);
    assert.equal(reopened.getAccount("muse-this-mac")!.homePath, "/tmp/native-test-home");
    reopened.close();
  } finally { h.cleanup(); }
});


test("core account id validation admits retained @ identities and rejects unsafe or overlong ids", () => {
  const h = harness();
  try {
    const store = h.open();
    for (const id of ["claude-test@share123", "native:claude", `a${"x".repeat(209)}`]) {
      assert.equal(isAccountId(id), true);
      assert.equal(store.createAccount({ id, harness: "claude", label: "id-test", homePath: "/tmp/id-test" }).id, id);
    }
    for (const id of ["", "auto", "rr", "../escape", "a/b", "a\\b", "a b", "a".repeat(211)]) {
      assert.equal(isAccountId(id), false);
      assert.throws(() => store.createAccount({ id, harness: "claude", label: "id-test", homePath: "/tmp/id-test" }));
    }
    store.close();
  } finally { h.cleanup(); }
});

test("authority instance: v41 active authority is scoped once, disabled stays legacy, replay and restart preserve identity", () => {
  const h = harness();
  try {
    let store = h.open();
    for (const [id, phase] of [["claude-scope", "ready"], ["claude-disabled", "disabled"]] as const) {
      store.createAccount({ id, harness: "claude", label: id, homePath: "/tmp/owned-instance-test" });
      store.putAccountCredentialAuthority({ account: id, phase, generation: 8, expiresAt: 9999, operationKey: null });
    }
    store.close();
    const db = new DatabaseSync(h.path);
    db.exec("ALTER TABLE account_credential_authorities DROP COLUMN authority_instance_id; UPDATE meta SET value = '41' WHERE key = 'schema_version'");
    db.close();
    store = h.open();
    const id = store.getAccountCredentialAuthority("claude-scope")!.authorityInstanceId;
    assert.match(id!, /^[a-f0-9-]{36}$/);
    assert.equal(store.getAccountCredentialAuthority("claude-disabled")!.authorityInstanceId, undefined);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close(); store = h.open();
    assert.equal(store.getAccountCredentialAuthority("claude-scope")!.authorityInstanceId, id);
    store.close();
  } finally { h.cleanup(); }
});

test("lease migration preserves canonical revocation and reopens without rewriting rows", () => {
  for (const revokedAt of [123, null]) {
    const h = harness();
    const initial = h.open();
    initial.createAccount({ id: "claude-precedence", harness: "claude", homePath: join(dirname(h.path), "account-home"), label: "precedence" });
    initial.close();
    const seed = new DatabaseSync(h.path);
    seed.prepare("UPDATE accounts SET source='leased', leased_from=?").run(JSON.stringify({ shareId: "s", authorityNodeId: "n", epoch: 1, expiresAt: null, adoptedAt: null, revokedAt, endedAt: revokedAt === null ? 456 : null }));
    seed.close();
    let previous: string | null = null;
    try {
      for (let reopen = 0; reopen < 2; reopen++) {
        const store = h.open();
        assert.equal(knownAccountLease(store.getAccount("claude-precedence"))?.revokedAt, revokedAt);
        store.close();
        const inspect = new DatabaseSync(h.path, { readOnly: true });
        try {
          const raw = String(inspect.prepare("SELECT leased_from FROM accounts").get()?.leased_from);
          assert.equal(Object.hasOwn(JSON.parse(raw), "endedAt"), false);
          if (previous !== null) assert.equal(raw, previous);
          previous = raw;
        } finally { inspect.close(); }
      }
    } finally { h.cleanup(); }
  }
});
