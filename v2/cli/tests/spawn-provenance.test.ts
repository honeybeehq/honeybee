import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { harness } from "../../core/tests/helpers.ts";
import { makeDaemonDir } from "../../daemon/tests/helpers.ts";
import { ReadOnlyStore } from "../src/readonly.ts";
import { runV2Cli } from "../src/main.ts";

test("stale reads preserve stored provenance and never infer legacy provenance", () => {
  const h = harness();
  const core = h.open();
  const provenance = { callerBeeId: null, authority: "registered_service" as const, peerPid: 123, serviceIntent: "delegation" as const };
  core.createBee({ id: "parent", name: "parent", agent: "stub", substrate: "hsr", cwd: "/tmp" });
  core.createBee({ id: "child", name: "child", agent: "stub", substrate: "hsr", cwd: "/tmp", parentId: "parent", spawnProvenance: provenance });
  core.close();
  let reader = new ReadOnlyStore(h.path);
  try {
    assert.deepEqual(reader.view("child").bee?.spawnProvenance, provenance);
    assert.equal(reader.view("parent").bee?.spawnProvenance, null);
    reader.close();
    const db = new DatabaseSync(h.path);
    db.exec("ALTER TABLE bees DROP COLUMN spawn_provenance");
    db.close();
    reader = new ReadOnlyStore(h.path);
    assert.equal(reader.view("child").bee?.spawnProvenance, null);
  } finally {
    reader.close();
    h.cleanup();
  }
});

for (const capabilities of [[], ["spawn.provenance.v1"]]) {
  test(`explicit service intent uses only capable RPC context (${capabilities.length})`, async () => {
    const { dir, cleanup } = makeDaemonDir();
    const socketPath = join(dir, "hived.sock");
    const requests: Array<{ id: number; verb: string; params: Record<string, unknown>; context?: unknown }> = [];
    const savedBeeId = process.env.HIVE_BEE_ID;
    process.env.HIVE_BEE_ID = "ambient-is-not-authority";
    const server = createServer(socket => {
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify({ protocol: "v2/2", capabilities })}\n`);
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const frame = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (typeof frame.id !== "number" || !frame.verb) continue;
          requests.push(frame);
          const template = { id: "template", name: "template", scope: "global", agent: "stub", args: [], env: {}, tags: [], prompt: "hello", cwdPolicy: "inherit" };
          const result = frame.verb === "template.list" ? { templates: [template] } : frame.verb === "template.get" ? { template } : frame.verb === "list" ? { views: [{ bee: { id: "source", name: "source", agent: "stub", providerSessionId: "session" }, view: {} }] } : frame.verb === "view" ? { bee: { providerSessionId: "session" } } : null;
          socket.write(`${JSON.stringify(result ? { id: frame.id, ok: true, result } : { id: frame.id, ok: false, error: { code: "invalid_request", message: "captured" } })}\n`);
        }
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      for (const args of [["spawn", "new", "--no-parent"], ["template", "run", "template", "--no-parent"], ["spawn", "--template", "template", "--no-parent"], ["x", "new", "hello", "--no-parent"], ["xa", "stub", "--no-parent"], ["run", "new", "hello", "--no-parent"], ["fork", "source"], ["thread-fork", "source"], ["thread-handoff", "source", "--instruction", "continue"]]) {
        requests.length = 0;
        const errors: string[] = [];
        assert.equal(await runV2Cli([...args, "--service-intent", "delegation", "--data-dir", dir, "--socket", socketPath], { out() {}, err: line => errors.push(line) }), 1);
        if (!capabilities.length) {
          assert.match(errors.join("\n"), /capability_missing/);
          assert.equal(requests.some(request => !request.verb.startsWith("template.")), false);
        } else {
          const mutation = requests.at(-1)!;
          assert.deepEqual(mutation.context, { serviceIntent: "delegation" });
          assert.equal(Object.hasOwn(mutation.params, "serviceIntent"), false);
          assert.equal(requests.slice(0, -1).some(request => request.context !== undefined), false);
        }
      }
      for (const intent of ["service", undefined, "invalid"]) {
        requests.length = 0;
        const errors: string[] = [];
        await runV2Cli(["spawn", "new", "--no-parent", ...(intent ? ["--service-intent", intent] : []), "--data-dir", dir, "--socket", socketPath], { out() {}, err: line => errors.push(line) });
        if (intent === "invalid") {
          assert.match(errors.join("\n"), /requires service or delegation/);
          assert.equal(requests.length, 0);
        } else if (!intent || capabilities.length) {
          assert.deepEqual(requests.at(-1)?.context, intent ? { serviceIntent: intent } : undefined);
        }
      }
    } finally {
      if (savedBeeId === undefined) delete process.env.HIVE_BEE_ID;
      else process.env.HIVE_BEE_ID = savedBeeId;
      await new Promise<void>(resolve => server.close(() => resolve()));
      cleanup();
    }
  });
}
