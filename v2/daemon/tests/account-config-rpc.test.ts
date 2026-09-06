import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcClient } from "../../cli/src/client.ts";
import {
  RpcError,
  type AccountAddResult,
  type AccountConfigImportResult,
  type AccountConfigPreviewResult,
  type DeployInfoResult,
} from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

async function rejects(client: RpcClient, verb: "account.config.preview" | "account.config.import", params: Record<string, unknown>, code: string): Promise<void> {
  try {
    await client.request(verb, params);
  } catch (error) {
    assert.ok(error instanceof RpcError, `expected RpcError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

test("rpc account config: fixed preview/import contract, typed refusals, serialized imports, and durable exact retry", async () => {
  const { dir, cleanup } = makeDaemonDir();
  const machineHome = join(dir, "machine-home");
  const sourceHome = join(machineHome, ".codex");
  mkdirSync(sourceHome, { recursive: true });
  writeFileSync(join(sourceHome, "AGENTS.md"), "machine instructions\n");
  writeFileSync(join(sourceHome, "config.toml"), 'model = "gpt-safe"\nmodel_reasoning_effort = "high"\napi_key = "RPC_AUTH_MUST_NOT_COPY"\n');
  const daemonEnv = { HOME: machineHome, CODEX_HOME: sourceHome };
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: daemonEnv });
    let client = await daemon.client();
    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.ok(info.capabilities.includes("account.config.import.v1"));

    const added = await client.request<AccountAddResult>("account.add", { harness: "codex", label: "work", idempotencyKey: "add-work" });
    const preview = await client.request<AccountConfigPreviewResult>("account.config.preview", { id: "work" });
    assert.equal(preview.accountId, added.account.id);
    assert.equal(preview.harness, "codex");
    assert.equal(preview.sourceHome, sourceHome);
    assert.equal(preview.entries.find((entry) => entry.path === "AGENTS.md")?.status, "ready");
    assert.equal(preview.entries.find((entry) => entry.path === "config.toml")?.status, "ready");
    assert.doesNotMatch(JSON.stringify(preview), /machine instructions|RPC_AUTH_MUST_NOT_COPY|gpt-safe/);
    await rejects(client, "account.config.import", { id: "work" }, "invalid_request");

    const first = await client.request<AccountConfigImportResult>("account.config.import", { id: "work", idempotencyKey: "config-work" });
    assert.deepEqual(first.imported.sort(), ["AGENTS.md", "config.toml"]);
    assert.equal(Object.hasOwn(first, "deduped"), false);
    assert.doesNotMatch(readFileSync(join(added.account.homePath, "config.toml"), "utf8"), /RPC_AUTH_MUST_NOT_COPY/);

    client.close();
    await daemon.stop();
    daemon = await startDaemon(dir, { env: daemonEnv });
    client = await daemon.client();
    const replay = await client.request<AccountConfigImportResult>("account.config.import", { id: "work", idempotencyKey: "config-work" });
    assert.deepEqual(replay, first, "the durable retry returns the original exact wire result after restart");
    assert.equal(Object.hasOwn(replay, "deduped"), false);

    const concurrent = await client.request<AccountAddResult>("account.add", { harness: "codex", label: "concurrent", idempotencyKey: "add-concurrent" });
    const other = await daemon.client();
    const results = await Promise.all([
      client.request<AccountConfigImportResult>("account.config.import", { id: concurrent.account.id, idempotencyKey: "config-concurrent-a" }),
      other.request<AccountConfigImportResult>("account.config.import", { id: concurrent.account.id, idempotencyKey: "config-concurrent-b" }),
    ]);
    other.close();
    assert.deepEqual(results.map((result) => result.imported.length).sort((left, right) => left - right), [0, 2]);
    assert.equal(readFileSync(join(concurrent.account.homePath, "AGENTS.md"), "utf8"), "machine instructions\n");

    await client.request<AccountAddResult>("account.add", { harness: "stub", label: "unsupported", idempotencyKey: "add-unsupported" });
    await rejects(client, "account.config.preview", { id: "stub-unsupported" }, "config_import_unsupported");
    await client.request<AccountAddResult>("account.add", {
      harness: "codex",
      label: "same-home",
      homePath: sourceHome,
      idempotencyKey: "add-same-home",
    });
    await rejects(client, "account.config.preview", { id: "codex-same-home" }, "config_import_refused");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
