import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter, museAdapter } from "../../adapters/src/index.ts";
import { journalDeliveryEvidence } from "../src/delivery-evidence.ts";

test("journal evidence counts only complete responses to one message's delivery requests, across read chunks", t => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adapter = codexAdapter({ cwd: dir });
  const evidenceFor = (path: string, messageId: number) => journalDeliveryEvidence(path, adapter.deliveryResponseMarker!(messageId), messageId, line => adapter.parseLine(line));
  const longOutput = JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "x".repeat(3 * 1024 * 1024) } });
  const refusal = JSON.stringify({ id: 1645, error: { code: -32600, message: "no active turn to steer" } });
  const journal = join(dir, "journal.jsonl");
  writeFileSync(journal, [
    JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "mentions 1645 in passing" } }),
    refusal,
    longOutput,
    JSON.stringify({ id: 1646, result: { turn: { id: "another-message" } } }),
    longOutput,
    refusal,
    JSON.stringify({ jsonrpc: "2.0", id: 1645, result: { turn: { id: "accepted" } } }),
  ].join("\n") + "\n" + '{"id":1645,"result":{"turn":{"id":"torn-line"');
  assert.deepEqual(evidenceFor(journal, 645), { accepted: 1, refused: 2 });
  assert.deepEqual(evidenceFor(journal, 646), { accepted: 1, refused: 0 });
  assert.deepEqual(evidenceFor(journal, 999), { accepted: 0, refused: 0 });
  assert.equal(evidenceFor(join(dir, "missing.jsonl"), 645), null);
});

test("codex and muse name the request id a delivery response carries", () => {
  assert.equal(codexAdapter({ cwd: "/fixture" }).deliveryResponseMarker!(90645), "91645");
  assert.equal(museAdapter({ cwd: "/fixture" }).deliveryResponseMarker!(90645), "91645");
});
