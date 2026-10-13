import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection, createServer, type Socket, type AddressInfo } from "node:net";
import { RpcServer, assertLocalHandoffRpc, type RpcConn } from "../src/rpc.ts";
import { PROTOCOL, RpcError } from "../src/protocol.ts";

test("handoff ingress: remote TCP cannot claim local Unix authority and missing provenance fails closed", async () => {
  const rpc = new RpcServer({ socketPath: "unused-test-socket", log: () => {}, dispatch: (verb, params, conn) => {
    assertLocalHandoffRpc(verb, params, conn);
    return { ingress: conn.ingress };
  } });
  const sockets: Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket);
    (rpc as unknown as { onConnection(socket: Socket): void }).onConnection(socket);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    for (const clientLane of [undefined, "node_relay", "local_unix"]) {
      const socket = createConnection({ port, host: "127.0.0.1" }); sockets.push(socket); socket.setEncoding("utf8");
      let buffer = "";
      const frames: Record<string, unknown>[] = [];
      let waiting: ((frame: Record<string, unknown>) => void) | null = null;
      socket.on("data", chunk => {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf("\n"); if (index < 0) break;
          const frame = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>; buffer = buffer.slice(index + 1);
          if (waiting) { const consume = waiting; waiting = null; consume(frame); } else frames.push(frame);
        }
      });
      const next = () => frames.length ? Promise.resolve(frames.shift()!) : new Promise<Record<string, unknown>>(resolve => { waiting = resolve; });
      await next();
      socket.write(JSON.stringify({ protocol: PROTOCOL, ...(clientLane ? { clientLane } : {}) }) + "\n");
      if (clientLane === "local_unix") {
        const invalid = await next(); assert.equal((invalid.error as Record<string, unknown>).code, "invalid_request");
      } else {
        socket.write(JSON.stringify({ id: 1, verb: "account.credentials.handoffIdentitySet", params: { identity: { nodeId: "dummy-self", deviceKey: "dummy-public-device" }, ingress: "local_unix" } }) + "\n");
        const refused = await next(); assert.equal((refused.error as Record<string, unknown>).code, "credential_handoff_conflict");
        socket.write(JSON.stringify({ id: 2, verb: "account.list", params: {} }) + "\n");
        assert.equal(((await next()).result as Record<string, unknown>).ingress, "remote");
      }
      socket.destroy();
    }
    const unknown: RpcConn = { send: () => {}, subscribeWatch: () => {}, alignWatch: () => {} };
    assert.throws(() => assertLocalHandoffRpc("account.credentials.exportPrepare", { targetKey: "dummy-public-key" }, unknown), error => error instanceof RpcError && error.code === "credential_handoff_conflict");
    console.log("handoff ingress: physical TCP and relayed hello refuse facts; local_unix hello/parameter cannot upgrade; unknown provenance refuses");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
