import type { ChildProcess } from "node:child_process";

export async function waitForGateProfile(rowId: string, fixtureRoot: string): Promise<void> {
  const endpoint = process.env.SCG_FIXTURE_CONTROL_SOCKET;
  if (endpoint === undefined) return;
  const {createConnection} = await import("node:net");
  const locator = Buffer.from(JSON.stringify({version: 1, operation: "profile-ready", rowId, fixtureRoot}) + "\n");
  if (!endpoint.startsWith("/") || locator.length > 4096) throw new Error("gate_fixture_barrier_invalid_locator");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let bytes = Buffer.alloc(0);
    const socket = createConnection(endpoint);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("gate_fixture_barrier_timeout")), 30000);
    socket.on("error", () => finish(new Error("gate_fixture_barrier_transport")));
    socket.on("connect", () => socket.write(locator));
    socket.on("data", chunk => {
      if (!Buffer.isBuffer(chunk)) {finish(new Error("gate_fixture_barrier_ack_invalid")); return;}
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 256) finish(new Error("gate_fixture_barrier_ack_bound"));
    });
    socket.on("end", () => {
      if (bytes.equals(Buffer.from('{"version":1,"approved":true}\n'))) finish();
      else finish(new Error("gate_fixture_barrier_ack_invalid"));
    });
    socket.on("close", () => {if (!settled) finish(new Error("gate_fixture_barrier_closed"));});
  });
}

export async function disposeAndAwaitOwnedChild(child: ChildProcess | null | undefined, dispose: () => void, removeRoot: () => void): Promise<void> {
  if (!child) {
    dispose();
    throw new Error("delivery_read_cleanup_child_missing");
  }
  const exited = new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {resolve(); return;}
    const done = () => {clearTimeout(timer); resolve();};
    const timer = setTimeout(() => {
      child.removeListener("exit", done);
      reject(new Error("delivery_read_cleanup_exit_timeout"));
    }, 3000);
    child.once("exit", done);
  });
  const errors: unknown[] = [];
  try {dispose();} catch (error) {errors.push(error);}
  let gone = false;
  try {await exited; gone = true;} catch (error) {errors.push(error);}
  if (gone) {
    try {removeRoot();} catch (error) {errors.push(error);}
  }
  if (errors.length) throw new AggregateError(errors, "delivery_read_cleanup_failed", {cause: errors[0]});
}
