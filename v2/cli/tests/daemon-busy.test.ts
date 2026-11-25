import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shortSocketDir } from "../../daemon/src/socketPath.ts";
import { runV2Cli } from "../src/main.ts";

async function cli(args: string[]): Promise<{ exit: number; err: string[]; json: Record<string, any>[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const exit = await runV2Cli(args, { out: line => out.push(line), err: line => err.push(line) });
  return { exit, err, json: out.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) };
}

test("a live socket that never says hello is 'starting or busy' (exit 75), never 'start the daemon'; a missing socket is still unreachable (exit 1)", { timeout: 30_000 }, async () => {
  const dir = shortSocketDir("hb-busy-", "hived.sock", [tmpdir()]);
  const socketPath = join(dir, "hived.sock");
  const held: Socket[] = [];
  const silent = createServer(socket => { held.push(socket); });
  await new Promise<void>(resolve => silent.listen(socketPath, resolve));
  try {
    const busy = await cli(["health", "--json", "--socket", socketPath]);
    assert.equal(busy.exit, 75);
    assert.equal(busy.json[0]?.error.code, "daemon_busy");
    assert.equal(busy.json[0]?.error.details.socketPath, socketPath);
    assert.match(busy.err.join("\n"), /is starting or busy: it accepted the connection but sent no hello within 3 s\. It is running: do not start another\./);
    assert.doesNotMatch(busy.err.join("\n"), /start it with|not reachable/);
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise<void>(resolve => silent.close(() => resolve()));
  }
  const missing = await cli(["health", "--json", "--socket", socketPath]);
  assert.equal(missing.exit, 1);
  assert.equal(missing.json[0]?.error.code, "socket_unreachable");
  assert.match(missing.err.join("\n"), /not reachable .*\(ENOENT\) — start it with: hive daemon run/);
  rmSync(dir, { recursive: true, force: true });
});
