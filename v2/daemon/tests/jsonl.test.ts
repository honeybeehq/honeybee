import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "../../cli/src/client.ts";
import { PROTOCOL } from "../src/protocol.ts";
import { JsonLineBuffer } from "../src/jsonl.ts";

test("JSONL retains fragments and emits ordered complete frames", () => {
  const frames = new JsonLineBuffer();
  assert.deepEqual(frames.push(""), []);
  assert.deepEqual(frames.push('{"a":'), []);
  assert.deepEqual(frames.push('1}\n\n{"b":2}\n{"c"'), ['{"a":1}', "", '{"b":2}']);
  assert.deepEqual(frames.push(':3}\n'), ['{"c":3}']);
  assert.deepEqual(frames.push('last\n'), ["last"]);
  assert.deepEqual(frames.push(""), []);
});

test("JSONL indexOf work is linear for a 20 MiB fragmented frame", () => {
  const frames = new JsonLineBuffer();
  const chunk = "x".repeat(8192);
  const original = String.prototype.indexOf;
  let searched = 0;
  String.prototype.indexOf = function (search: string, start?: number): number {
    searched += Math.max(0, this.length - (start ?? 0));
    return original.call(this, search, start);
  };
  let result: string[];
  try {
    for (let i = 0; i < 2560; i++) assert.deepEqual(frames.push(chunk), []);
    result = frames.push("\nnext\n");
  } finally {
    String.prototype.indexOf = original;
  }
  assert.deepEqual(result, [chunk.repeat(2560), "next"]);
  assert.ok(searched <= 2560 * chunk.length + 20);
});

test("RPC client accepts a fragmented hello with blank lines and an incomplete following frame", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hb-jsonl-"));
  const socketPath = join(dir, "rpc.sock");
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write('{"proto');
    const timer = setTimeout(() => socket.write(`col":${JSON.stringify(PROTOCOL)}}\n\n{"type":"gap","seq":`), 10);
    socket.on("close", () => clearTimeout(timer));
    let incoming = "";
    socket.on("data", (chunk: string) => {
      incoming += chunk;
      for (;;) {
        const newline = incoming.indexOf("\n");
        if (newline < 0) return;
        const frame = JSON.parse(incoming.slice(0, newline)) as { id?: number };
        incoming = incoming.slice(newline + 1);
        if (frame.id === undefined) continue;
        socket.write(`7}\n${JSON.stringify({ id: frame.id, ok: true, result: "connected" })}\n`);
      }
    });
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = await RpcClient.connect(socketPath);
  t.after(() => client.close());
  const events: unknown[] = [];
  client.onEvent = frame => events.push(frame);
  try {
    assert.equal(await client.request("health"), "connected");
    assert.deepEqual(events, [{ type: "gap", seq: 7 }]);
  } finally {
    client.close();
  }
});
