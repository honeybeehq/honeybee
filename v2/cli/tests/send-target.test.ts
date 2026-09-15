import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runV2Cli } from "../src/main.ts";
import { RpcServer } from "../../daemon/src/rpc.ts";
import { RpcError } from "../../daemon/src/protocol.ts";

const target = "00000000-0000-4000-8000-000000000001";
const sender = "00000000-0000-4000-8000-000000000002";
const absent = "00000000-0000-4000-8000-000000000003";
const rows = [
  { bee: { id: target, name: "worker", handle: "CO.work" } },
  { bee: { id: sender, name: "caller", handle: "CO.call" } },
  { bee: { id: "old-id", name: absent, handle: "CO.old" } },
];

// Run the real CLI and protocol over a private socket; only daemon responses
// are controlled. Assert both routing and mutation payloads, including failures.
test("send: exact-ID lookup preserves fallback and sender authority", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hb-send-target-"));
  const socketPath = join(dir, "rpc.sock");
  const requests: Array<{ verb: string; params: Record<string, unknown> }> = [];
  let failView = false;
  const server = new RpcServer({ socketPath, log: () => {}, dispatch(verb, params) {
    requests.push({ verb, params });
    if (verb === "list") return { views: rows };
    if (verb === "view") {
      if (failView) throw new RpcError("node_stopped", "controlled failure");
      return rows.find((row) => row.bee.id === params.beeId) ?? { bee: null };
    }
    if (verb === "send") return { messageId: 17, commandId: null, unarchived: false };
    if (verb === "mailbox") return { messages: [{ id: 17, deliveredAt: 123, deliveredGeneration: 2 }] };
    throw new Error(`unexpected verb ${verb}`);
  } });
  const keys = ["HIVE_BEE_ID", "HIVE_BEE", "HIVE_V2_DATA_DIR"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  async function run(needle: string, flags: string[] = [], env: Record<string, string> = {}, verb = "send") {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, env);
    requests.length = 0;
    const out: string[] = [], err: string[] = [];
    const exit = await runV2Cli([verb, ...(verb === "buz" ? ["send"] : []), needle, "payload", "--socket", socketPath, "--data-dir", dir, "--json", ...flags], { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { exit, out, err, verbs: requests.map((r) => r.verb), send: requests.find((r) => r.verb === "send")?.params };
  }
  try {
    await server.listen();
    await t.test("exact ID avoids the list and preserves urgency, key and wait", async () => {
      const result = await run(target, ["--urgency", "idle", "--idempotency-key", "send-key", "--wait"]);
      assert.equal(result.exit, 0);
      assert.deepEqual(result.verbs, ["view", "send", "mailbox"]);
      assert.deepEqual(result.send, { beeId: target, body: "payload", urgency: "idle", idempotencyKey: "send-key" });
      assert.equal(JSON.parse(result.out[0]!).deliveredGeneration, 2);
    });
    await t.test("names, case-insensitive handles, prefixes and non-UUID IDs keep full lookup", async () => {
      for (const [needle, id] of [["worker", target], ["co.WORK", target], ["work", target], ["old-id", "old-id"]]) {
        const result = await run(needle!); assert.equal(result.exit, 0); assert.deepEqual(result.verbs, ["list", "send"]); assert.equal(result.send?.beeId, id);
      }
    });
    await t.test("UUID-shaped name falls back and exact ID takes precedence over a name", async () => {
      assert.equal((await run(absent)).send?.beeId, "old-id");
      assert.deepEqual(requests.map((r) => r.verb), ["view", "list", "send"]);
      rows.push({ bee: { id: "collision", name: target, handle: "CO.collision" } });
      try { assert.equal((await run(target)).send?.beeId, target); } finally { rows.pop(); }
    });
    await t.test("missing and ambiguous recipients never send", async () => {
      const missing = await run("00000000-0000-4000-8000-000000000099");
      assert.deepEqual(missing.verbs, ["view", "list"]); assert.equal(missing.exit, 1); assert.match(missing.err.join(""), /bee not found/); assert.equal(missing.send, undefined);
      const ambiguous = await run("CO."); assert.equal(ambiguous.exit, 1); assert.match(ambiguous.err.join(""), /ambiguous/); assert.equal(ambiguous.send, undefined);
    });
    await t.test("ambient identity survives the fast path; foreign authority remains operator", async () => {
      const env = { HIVE_BEE_ID: sender, HIVE_BEE: "caller", HIVE_V2_DATA_DIR: dir };
      const peer = await run(target, [], env); assert.equal(peer.send?.sender, sender); assert.deepEqual(peer.verbs, ["view", "send"]);
      assert.equal((await run(target, [], { ...env, HIVE_V2_DATA_DIR: join(dir, "other") })).send?.sender, undefined);
      const invalid = await run(target, [], { HIVE_BEE: "caller" }); assert.equal(invalid.exit, 1); assert.match(invalid.err.join(""), /HIVE_BEE_ID is missing/); assert.equal(invalid.send, undefined);
    });
    await t.test("explicit aliases and forged sender claims retain the full resolver", async () => {
      const env = { HIVE_BEE_ID: sender, HIVE_BEE: "caller", HIVE_V2_DATA_DIR: dir };
      for (const alias of [sender, "caller", "CO.call", "call"]) {
        const result = await run(target, ["--sender", alias], env); assert.equal(result.exit, 0); assert.deepEqual(result.verbs, ["list", "send"]); assert.equal(result.send?.sender, sender);
      }
      for (const [alias, identity] of [[target, env], [sender, {}], [sender, { ...env, HIVE_V2_DATA_DIR: join(dir, "other") }]] as const) {
        const result = await run(target, ["--sender", alias], identity); assert.equal(result.exit, 1); assert.equal(result.send, undefined); assert.deepEqual(result.verbs, ["list"]);
      }
    });
    await t.test("buz human sender is preserved and cannot be claimed by a bee", async () => {
      const human = await run(target, ["--sender-human", "Tormod"], {}, "buz"); assert.equal(human.exit, 0); assert.equal(human.send?.sender, "human:Tormod");
      const forged = await run(target, ["--sender-human", "Tormod"], { HIVE_BEE_ID: sender }, "buz"); assert.equal(forged.exit, 1); assert.equal(forged.send, undefined);
    });
    await t.test("view errors propagate without list fallback or mutation", async () => {
      failView = true; const result = await run(target); assert.equal(result.exit, 1); assert.match(result.err.join(""), /controlled failure/); assert.deepEqual(result.verbs, ["view"]);
    });
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await server.close(); rmSync(dir, { recursive: true, force: true });
  }
});
