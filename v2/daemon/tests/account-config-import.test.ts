import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountRow } from "../../core/src/index.ts";
import { AccountConfigImportRefusal, AccountConfigImportService } from "../src/accountConfigImport.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "config-import");

function account(harness: string, homePath: string): AccountRow {
  return {
    id: `${harness}-work`,
    harness,
    homePath,
    label: "work",
    status: "ok",
    penalty: 0,
    lastLoginAt: null,
    exhaustedAt: null,
    addedAt: 1,
    updatedAt: 1,
  };
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("account config import: Claude copies config-only files, merges missing safe values, preserves destination auth and conflicts", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-config-claude-"));
  try {
    const machineHome = join(root, "machine");
    const sourceHome = join(machineHome, ".claude");
    const destination = join(root, "account");
    cpSync(join(fixtures, "claude", ".claude"), sourceHome, { recursive: true });
    mkdirSync(machineHome, { recursive: true });
    cpSync(join(fixtures, "claude", ".claude.json"), join(machineHome, ".claude.json"));
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "CLAUDE.md"), "destination instructions\n");
    writeFileSync(join(destination, ".claude.json"), JSON.stringify({
      oauthAccount: { accessToken: "DESTINATION_AUTH_STAYS" },
      mcpServers: { local: { command: "/usr/bin/local-mcp", args: ["serve"] } },
    }, null, 2));
    writeFileSync(join(destination, "settings.json"), JSON.stringify({
      model: "destination-model",
      permissions: { allow: ["Read"] },
      env: { ANTHROPIC_API_KEY: "DESTINATION_SETTINGS_AUTH_STAYS" },
    }, null, 2));

    const service = new AccountConfigImportService({ env: { HOME: machineHome }, home: machineHome });
    const preview = service.preview(account("claude", destination));
    assert.equal(preview.sourceHome, sourceHome);
    assert.equal(preview.entries.find((entry) => entry.path === "CLAUDE.md")?.status, "skipped");
    assert.equal(preview.entries.find((entry) => entry.path === ".claude.json")?.status, "ready");
    assert.equal(preview.entries.find((entry) => entry.path === "settings.json")?.status, "ready");
    const result = service.import(account("claude", destination));
    assert.equal(readFileSync(join(destination, "CLAUDE.md"), "utf8"), "destination instructions\n");
    assert.ok(result.skipped.includes("CLAUDE.md"));
    assert.ok(result.imported.includes("skills/review/SKILL.md"));
    assert.ok(result.imported.includes("commands/check.md"));

    const state = json(join(destination, ".claude.json"));
    assert.deepEqual(state.oauthAccount, { accessToken: "DESTINATION_AUTH_STAYS" });
    assert.deepEqual(state.mcpServers, {
      local: { command: "/usr/bin/local-mcp", args: ["serve"] },
      docs: { command: "/usr/bin/docs-mcp", args: ["serve"] },
    });
    const settings = json(join(destination, "settings.json"));
    assert.equal(settings.model, "destination-model");
    assert.equal(settings.language, "English");
    assert.deepEqual(settings.permissions, { allow: ["Read"] }, "destination arrays replace source arrays");
    assert.deepEqual(settings.env, { ANTHROPIC_API_KEY: "DESTINATION_SETTINGS_AUTH_STAYS" });
    const destinationBytes = [readFileSync(join(destination, ".claude.json"), "utf8"), readFileSync(join(destination, "settings.json"), "utf8")].join("\n");
    assert.doesNotMatch(destinationBytes, /SOURCE_AUTH_MUST_NOT_COPY|MCP_AUTH_MUST_NOT_COPY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account config import: auth-only mixed JSON is skipped and malformed reasons are static", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-config-json-"));
  try {
    const sourceHome = join(root, "opencode-source");
    const destination = join(root, "account");
    mkdirSync(sourceHome, { recursive: true });
    writeFileSync(join(sourceHome, "opencode.json"), JSON.stringify({ provider: { xai: { options: { apiKey: "AUTH_ONLY" } } } }));
    const service = new AccountConfigImportService({ env: { HOME: root, OPENCODE_CONFIG_DIR: sourceHome }, home: root });
    const authOnly = service.preview(account("opencode", destination));
    const entry = authOnly.entries.find((candidate) => candidate.path === "opencode.json");
    assert.deepEqual(entry, { path: "opencode.json", kind: "file", status: "skipped", reason: "source has no safe configuration values" });

    writeFileSync(join(sourceHome, "opencode.json"), '{"provider":{"xai":{"options":{"apiKey":"AUTH_IN_PARSE_ERROR_');
    const malformed = service.preview(account("opencode", destination));
    assert.deepEqual(malformed.entries.find((candidate) => candidate.path === "opencode.json"), {
      path: "opencode.json",
      kind: "file",
      status: "skipped",
      reason: "source config is invalid JSONC",
    });
    assert.doesNotMatch(JSON.stringify(malformed), /AUTH_IN_PARSE_ERROR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account config import: JSONC comments survive safe extraction and unusable MCP servers do not make a config ready", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-config-jsonc-"));
  try {
    const sourceHome = join(root, "opencode-source");
    const destination = join(root, "account");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(sourceHome, "opencode.jsonc"), `{
      // OpenCode accepts comments and trailing commas.
      "model": "source-model",
      "provider": { "xai": { "options": { "apiKey": "OPENCODE_AUTH_MUST_NOT_COPY" } } },
      "mcp": {
        "stdio": { "type": "local", "command": ["docs-mcp"], "args": ["serve"], "environment": { "NAME": "{env:DOCS_NAME}", "TOKEN": "RAW_AUTH_MUST_NOT_COPY" } },
        "remote": { "type": "remote", "url": "https://mcp.example.test/events", "headers": { "Authorization": "Bearer REMOTE_AUTH_MUST_NOT_COPY" } },
        "token-url-only": { "type": "remote", "enabled": true, "url": "https://mcp.example.test/events?token=URL_AUTH_MUST_NOT_COPY" },
        "auth-only": { "type": "remote", "enabled": true, "headers": { "Authorization": "Bearer AUTH_ONLY_MUST_NOT_COPY" } },
      },
    }`);
    writeFileSync(join(destination, "opencode.json"), JSON.stringify({ model: "destination-model" }));
    const service = new AccountConfigImportService({ env: { HOME: root, OPENCODE_CONFIG_DIR: sourceHome }, home: root });
    const preview = service.preview(account("opencode", destination));
    assert.equal(preview.entries.find((entry) => entry.path === "opencode.json")?.status, "ready");
    service.import(account("opencode", destination));
    const config = json(join(destination, "opencode.json"));
    assert.equal(config.model, "destination-model");
    assert.deepEqual(config.mcp, {
      remote: { type: "remote", url: "https://mcp.example.test/events" },
      stdio: { type: "local", command: ["docs-mcp"], args: ["serve"], environment: { NAME: "{env:DOCS_NAME}" } },
    });
    assert.doesNotMatch(readFileSync(join(destination, "opencode.json"), "utf8"), /AUTH_MUST_NOT_COPY/);

    rmSync(join(sourceHome, "opencode.jsonc"));
    writeFileSync(join(sourceHome, "opencode.json"), JSON.stringify({
      provider: { xai: { apiKey: "AUTH_ONLY" } },
      mcp: { auth: { type: "remote", enabled: true, headers: { Authorization: "Bearer AUTH_ONLY" } } },
    }));
    rmSync(join(destination, "opencode.json"));
    assert.deepEqual(service.preview(account("opencode", destination)).entries.find((entry) => entry.path === "opencode.json"), {
      path: "opencode.json",
      kind: "file",
      status: "skipped",
      reason: "source has no safe configuration values",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account config import: Grok and Kimi TOML import safe settings without provider auth", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-config-toml-"));
  try {
    for (const harness of ["grok", "kimi"] as const) {
      const sourceHome = join(root, `${harness}-source`);
      const destination = join(root, `${harness}-account`);
      cpSync(join(fixtures, harness), sourceHome, { recursive: true });
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, "config.toml"), 'model = "destination-model"\n\n[auth]\nrefresh_token = "DESTINATION_AUTH_STAYS"\n');
      const env = harness === "grok" ? { HOME: root, GROK_HOME: sourceHome } : { HOME: root, KIMI_CODE_HOME: sourceHome };
      const service = new AccountConfigImportService({ env, home: root });
      const preview = service.preview(account(harness, destination));
      assert.equal(preview.entries.find((entry) => entry.path === "config.toml")?.status, "ready");
      service.import(account(harness, destination));
      const config = readFileSync(join(destination, "config.toml"), "utf8");
      assert.match(config, /model = "destination-model"/);
      assert.match(config, /refresh_token = "DESTINATION_AUTH_STAYS"/);
      assert.doesNotMatch(config, /SOURCE_AUTH_MUST_NOT_COPY|ACCESS_AUTH_MUST_NOT_COPY|MCP_AUTH_MUST_NOT_COPY|PROVIDER_AUTH_MUST_NOT_COPY/);
      if (harness === "grok") {
        assert.match(config, /reasoning_effort = "high"/);
        assert.match(config, /\[mcp_servers\.docs\]/);
        assert.match(config, /command = "\/usr\/bin\/docs-mcp"/);
        assert.match(config, /\[mcp_servers\.remote\]/);
        assert.doesNotMatch(config, /token-url-only|auth-only|URL_AUTH_MUST_NOT_COPY|REMOTE_AUTH_MUST_NOT_COPY/);
      }
      if (harness === "kimi") {
        assert.match(config, /default_model = "kimi-code\/k2\.5"/);
        assert.match(config, /\[providers\."managed:kimi-code"\]/);
        assert.match(config, /\[models\."kimi-code\/k2\.5"\]/);
        const tui = readFileSync(join(destination, "tui.toml"), "utf8");
        assert.match(tui, /theme = "dark"/);
        assert.doesNotMatch(tui, /TUI_AUTH_MUST_NOT_COPY/);
        const mcp = json(join(destination, "mcp.json"));
        assert.deepEqual(mcp.mcpServers, {
          docs: { command: "/usr/bin/docs-mcp", args: ["serve"] },
          remote: { type: "http", url: "https://mcp.example.test/events" },
        });
        assert.doesNotMatch(readFileSync(join(destination, "mcp.json"), "utf8"), /AUTH_MUST_NOT_COPY/);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account config import: environment homes win and source symlink escapes are reported without copying", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-config-links-"));
  try {
    const sourceHome = join(root, "codex-env");
    const destination = join(root, "account");
    const outside = join(root, "outside-skills");
    mkdirSync(sourceHome, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(sourceHome, "AGENTS.md"), "environment-selected\n");
    writeFileSync(join(outside, "SKILL.md"), "external\n");
    symlinkSync(outside, join(sourceHome, "skills"));
    const service = new AccountConfigImportService({ env: { HOME: root, CODEX_HOME: sourceHome }, home: root });
    const preview = service.preview(account("codex", destination));
    assert.equal(preview.sourceHome, sourceHome);
    assert.deepEqual(preview.entries.find((entry) => entry.path === "skills"), {
      path: "skills",
      kind: "directory",
      status: "skipped",
      reason: "source symlink resolves outside the vendor home",
    });
    const result = service.import(account("codex", destination));
    assert.equal(readFileSync(join(destination, "AGENTS.md"), "utf8"), "environment-selected\n");
    assert.ok(result.skipped.includes("skills"));
    assert.equal(result.imported.includes("skills/SKILL.md"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account config import: raw aliases cannot smuggle mixed config, env files, private keys, or destination links", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-config-content-rules-"));
  try {
    const sourceHome = join(root, "codex-source");
    const destination = join(root, "account");
    const outside = join(root, "outside");
    mkdirSync(join(sourceHome, "skills"), { recursive: true });
    mkdirSync(destination, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(sourceHome, "config.toml"), 'model = "safe-model"\napi_key = "STRUCTURED_AUTH_MUST_NOT_COPY"\n');
    symlinkSync("config.toml", join(sourceHome, "AGENTS.md"));
    writeFileSync(join(sourceHome, "skills", "safe.md"), "safe skill\n");
    writeFileSync(join(sourceHome, "skills", ".env.local"), "TOKEN=ENV_AUTH_MUST_NOT_COPY\n");
    writeFileSync(join(sourceHome, "skills", "id_rsa"), "PRIVATE_KEY_MUST_NOT_COPY\n");
    writeFileSync(join(sourceHome, "skills", "secret.pem"), "PEM_MUST_NOT_COPY\n");
    writeFileSync(join(sourceHome, "skills", "innocent-notes.md"), "-----BEGIN OPENSSH PRIVATE KEY-----\nKEY_MATERIAL_MUST_NOT_COPY\n");
    symlinkSync("../config.toml", join(sourceHome, "skills", "alias.md"));
    symlinkSync(outside, join(sourceHome, "prompts"));
    writeFileSync(join(outside, "safe.md"), "external\n");
    writeFileSync(join(outside, "destination-target"), "must remain\n");
    mkdirSync(join(destination, "skills"));
    symlinkSync(join(outside, "destination-target"), join(destination, "skills", "safe.md"));

    const service = new AccountConfigImportService({ env: { HOME: root, CODEX_HOME: sourceHome }, home: root });
    const preview = service.preview(account("codex", destination));
    assert.deepEqual(preview.entries.find((entry) => entry.path === "AGENTS.md"), {
      path: "AGENTS.md",
      kind: "file",
      status: "skipped",
      reason: "source symlink points at excluded configuration, credential, or state data",
    });
    assert.deepEqual(preview.entries.find((entry) => entry.path === "prompts"), {
      path: "prompts",
      kind: "directory",
      status: "skipped",
      reason: "source symlink resolves outside the vendor home",
    });
    const result = service.import(account("codex", destination));
    assert.ok(result.skipped.includes("skills/.env.local"));
    assert.ok(result.skipped.includes("skills/id_rsa"));
    assert.ok(result.skipped.includes("skills/secret.pem"));
    assert.ok(result.skipped.includes("skills/innocent-notes.md"));
    assert.ok(result.skipped.includes("skills/alias.md"));
    assert.ok(result.skipped.includes("skills/safe.md"), "a destination symlink is never followed or replaced");
    assert.equal(readFileSync(join(outside, "destination-target"), "utf8"), "must remain\n");
    assert.equal(readFileSync(join(destination, "config.toml"), "utf8").includes("safe-model"), true);
    assert.doesNotMatch(readFileSync(join(destination, "config.toml"), "utf8"), /STRUCTURED_AUTH_MUST_NOT_COPY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account config import: traversal depth and destination config reads are bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-config-bounds-"));
  try {
    const sourceHome = join(root, "codex-source");
    const destination = join(root, "account");
    let deepDirectory = join(sourceHome, "skills");
    mkdirSync(deepDirectory, { recursive: true });
    mkdirSync(destination, { recursive: true });
    for (let index = 0; index < 18; index += 1) {
      deepDirectory = join(deepDirectory, `level-${index}`);
      mkdirSync(deepDirectory);
    }
    writeFileSync(join(deepDirectory, "too-deep.md"), "not reached\n");
    writeFileSync(join(sourceHome, "config.toml"), 'model = "source-model"\n');
    writeFileSync(join(destination, "config.toml"), "x".repeat(1024 * 1024 + 1));
    const service = new AccountConfigImportService({ env: { HOME: root, CODEX_HOME: sourceHome }, home: root });
    const preview = service.preview(account("codex", destination));
    assert.deepEqual(preview.entries.find((entry) => entry.path === "skills"), {
      path: "skills",
      kind: "directory",
      status: "skipped",
      reason: "source directory traversal stopped at the bounded limit",
    });
    assert.deepEqual(preview.entries.find((entry) => entry.path === "config.toml"), {
      path: "config.toml",
      kind: "file",
      status: "skipped",
      reason: "destination config is unreadable or exceeds the 1 MiB limit",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account config import: unresolved Kimi default_model is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-config-kimi-model-"));
  try {
    const sourceHome = join(root, "kimi-source");
    const destination = join(root, "account");
    mkdirSync(sourceHome, { recursive: true });
    writeFileSync(join(sourceHome, "config.toml"), 'default_model = "missing-alias"\n[auth]\ntoken = "AUTH_MUST_NOT_COPY"\n');
    const service = new AccountConfigImportService({ env: { HOME: root, KIMI_CODE_HOME: sourceHome }, home: root });
    assert.deepEqual(service.preview(account("kimi", destination)).entries.find((entry) => entry.path === "config.toml"), {
      path: "config.toml",
      kind: "file",
      status: "skipped",
      reason: "source has no safe configuration values",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account config import: unknown harness and equal source/destination are typed refusals", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-config-refusal-"));
  try {
    const service = new AccountConfigImportService({ env: { HOME: root }, home: root });
    assert.throws(() => service.preview(account("stub", join(root, "stub"))), (error) => {
      assert.ok(error instanceof AccountConfigImportRefusal);
      assert.equal(error.reason, "unsupported_harness");
      return true;
    });
    const codexHome = join(root, ".codex");
    mkdirSync(codexHome, { recursive: true });
    assert.throws(() => service.preview(account("codex", codexHome)), (error) => {
      assert.ok(error instanceof AccountConfigImportRefusal);
      assert.equal(error.reason, "same_home");
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
