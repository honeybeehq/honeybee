import type { TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openCoreStore, type CoreStoreOptions } from "../../core/src/index.ts";
import { pinThreadHistory } from "../src/threadHistory.ts";
export function threadFixture(t: TestContext, kind: "fork" | "handoff" = "handoff", options: CoreStoreOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "hb-thread-"));
  const sourceSession = randomUUID();
  const sourcePath = join(root, "source.jsonl");
  const header = { timestamp: new Date().toISOString(), type: "session_meta", payload: { id: sourceSession, timestamp: new Date().toISOString(), cwd: root, originator: "codex_cli_rs", cli_version: "0.154.0", source: "cli", model_provider: "mock", base_instructions: { text: "You are a helpful coding assistant." } } };
  const user = { timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "We chose SQLite. The remaining work is the restart test." }] } };
  writeFileSync(sourcePath, JSON.stringify(header) + "\n" + JSON.stringify(user) + "\n");
  let store = openCoreStore(join(root, "store.sqlite"), options);
  store.createBee({ id: "source", name: "source", agent: "codex", substrate: "hsr", cwd: root, providerSessionId: sourceSession });
  store.updateRuntimeState("source", 1, "stopped", { exitCause: "stopped_by_user" });
  const input = { id: "operation", kind, idempotencyKey: "key", requestHash: "hash", sourceBeeId: "source", sourceProviderSessionId: sourceSession,
    successorBeeId: "successor", successorProviderSessionId: randomUUID(), instruction: kind === "handoff" ? "Emphasize the restart test and the SQLite decision." : null,
    source: pinThreadHistory(sourcePath, sourceSession), historyPath: join(root, "op", "history.jsonl"), sessionPath: join(root, "op", "successor.jsonl") };
  const row = store.admitThreadOperation(input, { id: "successor", name: "successor", agent: "codex", substrate: "hsr", cwd: root, parentId: "source", forkedFrom: "source" });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, row, sourcePath, get store() { return store; }, restart() { store.close(); store = openCoreStore(join(root, "store.sqlite"), options); return store; } };
}
