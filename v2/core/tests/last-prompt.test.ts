import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { replayAudit } from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("lastPromptAt delivery fact advances on delivered operator mail", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store, "prompted");
  bootToRunning(store, bee.id, 101, 1_001);

  const sent = store.send(bee.id, "please continue").message;
  assert.equal(store.getBee(bee.id)?.lastPromptAt, null);
  assert.deepEqual(store.markDelivered(sent.id, 1), { applied: true });
  const deliveredAt = store.getMessage(sent.id)?.deliveredAt ?? null;
  assert.ok(deliveredAt);
  assert.equal(store.getBee(bee.id)?.lastPromptAt, deliveredAt);
  assert.equal(store.view(bee.id).lastPromptAt, deliveredAt);
  const prompted = store.auditRows().filter((row) => row.kind === "bee.prompted");
  assert.equal(prompted.length, 1);
  assert.deepEqual(prompted[0]?.payload, {
    beeId: bee.id,
    lastPromptAt: deliveredAt,
    previous: null,
    messageId: sent.id,
    origin: "mail.send",
    sender: "operator",
  });
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

test("lastPromptAt ignores peer, action, handoff, and Honeybee system mail", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store, "target");
  const { bee: peer } = makeBee(store, "peer");
  bootToRunning(store, bee.id, 101, 1_001);

  const ignored = [
    store.send(bee.id, "from peer", { sender: peer.id }).message,
    store.send(bee.id, "action instruction", { sender: "hive:action", origin: "action.dispatch" }).message,
    store.send(bee.id, "action reminder", { sender: "hive:action", origin: "action.dispatch" }).message,
    store.send(bee.id, "handoff seed", { sender: "hive:handoff", origin: "handoff.seed" }).message,
    store.send(bee.id, "task supply", { sender: "task-supply" }).message,
    store.send(bee.id, "system spawn continuation", { sender: "honeybee", origin: "spawn.prompt" }).message,
  ];
  for (const message of ignored) assert.deepEqual(store.markDelivered(message.id, 1), { applied: true });

  assert.equal(store.getBee(bee.id)?.lastPromptAt, null);
  assert.equal(store.view(bee.id).lastPromptAt, null);
  assert.equal(store.auditRows().filter((row) => row.kind === "bee.prompted").length, 0);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

test("lastPromptAt migration backfills from delivered mail history", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const initial = h.open();
  const { bee } = makeBee(initial, "backfilled");
  const { bee: none } = makeBee(initial, "no-operator-mail");
  const { bee: peer } = makeBee(initial, "peer");
  bootToRunning(initial, bee.id, 101, 1_001);
  bootToRunning(initial, none.id, 102, 1_002);

  const first = initial.send(bee.id, "old operator").message;
  initial.markDelivered(first.id, 1);
  const peerMail = initial.send(bee.id, "peer mail", { sender: peer.id }).message;
  initial.markDelivered(peerMail.id, 1);
  const latest = initial.send(bee.id, "named human", { sender: "human:tormod" }).message;
  initial.markDelivered(latest.id, 1);
  const action = initial.send(none.id, "action", { sender: "hive:action", origin: "action.dispatch" }).message;
  initial.markDelivered(action.id, 1);
  const latestAt = initial.getMessage(latest.id)?.deliveredAt ?? null;
  assert.ok(latestAt);
  initial.close();

  const fixture = new DatabaseSync(h.path);
  fixture.exec("UPDATE bees SET last_prompt_at = NULL");
  fixture.exec("UPDATE meta SET value = '28' WHERE key = 'schema_version'");
  fixture.close();

  const reopened = h.open();
  assert.equal(reopened.getBee(bee.id)?.lastPromptAt, latestAt);
  assert.equal(reopened.view(bee.id).lastPromptAt, latestAt);
  assert.equal(reopened.getBee(none.id)?.lastPromptAt, null);
  assert.equal(reopened.view(none.id).lastPromptAt, null);
  reopened.close();
});
