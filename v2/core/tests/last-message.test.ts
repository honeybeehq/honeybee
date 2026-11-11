import { test } from "node:test";
import assert from "node:assert/strict";
import { LAST_MESSAGE_MAX_CHARS, lastMessageExcerpt, replayAudit, type CoreStore } from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

function idleBee(store: CoreStore) {
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 7, 7);
  store.updateRuntimeState(bee.id, 1, "idle");
  return bee;
}

test("last-message.1: the excerpt is one plain line bounded by LAST_MESSAGE_MAX_CHARS", () => {
  assert.equal(lastMessageExcerpt("## Done\n\n- Landed **abc123** on `main`.\n- See [the PR](https://x/1).\n\n```sh\ngit log\n```\n"), "Done Landed abc123 on main. See the PR. git log");
  assert.equal(lastMessageExcerpt("   \n\t"), null);
  assert.equal(lastMessageExcerpt(""), null);
  const long = "x".repeat(LAST_MESSAGE_MAX_CHARS + 50);
  assert.equal(lastMessageExcerpt(long)!.length, LAST_MESSAGE_MAX_CHARS);
  const astral = "😀".repeat(LAST_MESSAGE_MAX_CHARS + 1);
  assert.equal(Array.from(lastMessageExcerpt(astral)!).length, LAST_MESSAGE_MAX_CHARS);
});

test("last-message.2: turn end stores the excerpt, output.recorded carries it, a silent turn keeps it, replay agrees", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const bee = idleBee(store);
  assert.equal(store.getBee(bee.id)!.lastMessage, null);

  store.updateRuntimeState(bee.id, 1, "running");
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true, lastMessage: "**Landed** as abc123.\n\nNext: deploy." });
  assert.equal(store.getBee(bee.id)!.lastMessage, "Landed as abc123. Next: deploy.");
  const recorded = store.auditRows().filter((r) => r.kind === "output.recorded").at(-1)!;
  assert.equal(recorded.payload.lastMessage, "Landed as abc123. Next: deploy.");

  store.updateRuntimeState(bee.id, 1, "running");
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
  assert.equal(store.getBee(bee.id)!.lastMessage, "Landed as abc123. Next: deploy.");
  assert.equal(store.auditRows().filter((r) => r.kind === "output.recorded").at(-1)!.payload.lastMessage, undefined);

  store.updateRuntimeState(bee.id, 1, "running");
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true, lastMessage: "<quiet/>" });
  assert.equal(store.getBee(bee.id)!.lastMessage, "Landed as abc123. Next: deploy.", "a blank message does not clear the row");

  store.updateRuntimeState(bee.id, 1, "running");
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true, lastMessage: "y".repeat(500) });
  assert.equal(store.getBee(bee.id)!.lastMessage!.length, LAST_MESSAGE_MAX_CHARS);

  assert.throws(() => store.updateRuntimeState(bee.id, 1, "running", { lastMessage: "no" }), /lastMessage is only valid with recordOutput/);
  assert.deepEqual(replayAudit(store.auditRows()).bees.find((b) => b.id === bee.id)!.lastMessage, store.getBee(bee.id)!.lastMessage);
});
