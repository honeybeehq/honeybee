#!/usr/bin/env node
/**
 * Fake `muse serve` for daemon tests: speaks the slice of MSP v1 the Honeybee
 * muse adapter uses (initialize → initialized → session/start|resume →
 * turn/start ack, turn/started, an agentMessage item, turn/completed), in the
 * line shapes muse 1.4.7 emits on the echo provider. It refuses to run
 * without the account's isolated XDG pair and MUSE_NO_AUTO_UPDATE=1, like the
 * real recipe requires. No network, no credentials.
 *
 * env FAKE_MUSE_RECORDED  path to recorded server lines (jsonl). Each turn
 *                         replays the next line before its terminal: a
 *                         notification (e.g. usage/changed) verbatim; a
 *                         recorded turn/completed becomes that turn's
 *                         terminal with this session's ids.
 * env FAKE_MUSE_NATIVE=1  the machine's own login (This Mac): no account XDG
 *                         pair is required; only MUSE_NO_AUTO_UPDATE=1.
 * env FAKE_MUSE_ENV_OUT   path: write argv and the env Muse reads its login
 *                         and data dirs from, as JSON, at start.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const native = process.env.FAKE_MUSE_NATIVE === "1";
const config = process.env.XDG_CONFIG_HOME;
if (process.env.MUSE_NO_AUTO_UPDATE !== "1" || (!native && (!config || process.env.XDG_DATA_HOME !== join(config, "xdg-data")))) {
  process.stderr.write("fake-muse: the account's XDG_CONFIG_HOME / XDG_DATA_HOME pair and MUSE_NO_AUTO_UPDATE=1 are required\n");
  process.exit(3);
}
if (process.env.FAKE_MUSE_ENV_OUT) {
  const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "MUSE_NO_AUTO_UPDATE", "TBH_CREDENTIAL_BACKEND", "META_API_KEY", "MUSE_AUTH_PATH", "MUSE_LOGIN", "MUSE_CHANNEL", "FAKE_MUSE_KEPT"];
  writeFileSync(`${process.env.FAKE_MUSE_ENV_OUT}.${process.pid}.tmp`, JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(keys.filter((k) => k in process.env).map((k) => [k, process.env[k]])) }));
  renameSync(`${process.env.FAKE_MUSE_ENV_OUT}.${process.pid}.tmp`, process.env.FAKE_MUSE_ENV_OUT);
}
const dataHome = native ? process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share") : process.env.XDG_DATA_HOME;
if (process.argv[2] !== "serve") {
  process.stderr.write("fake-muse: only `serve` is implemented\n");
  process.exit(2);
}

const recorded = process.env.FAKE_MUSE_RECORDED
  ? readFileSync(process.env.FAKE_MUSE_RECORDED, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))
  : [];
const sessionId = "01a133e2-6725-7481-a1f9-1b611f7748be";
let cursor = 0;

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const notify = (method, params) => write({ method, params: { sessionId, ...params } });

function runTurn(turnId) {
  notify("session/statusChanged", { status: "running" });
  notify("turn/started", { commandId: turnId, turnId });
  notify("item/started", { item: { kind: "agentMessage", status: "inProgress", text: "", turnId } });
  notify("item/completed", { item: { kind: "agentMessage", status: "completed", text: "echo: ok", turnId } });
  let terminal = { durationMs: 5, terminal: "completed", turnId };
  const next = recorded[cursor++];
  if (next?.method === "turn/completed") terminal = { ...next.params, sessionId, turnId };
  else if (next) process.stdout.write(`${JSON.stringify(next)}\n`);
  notify("session/statusChanged", { status: "idle" });
  notify("turn/completed", terminal);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  switch (msg.method) {
    case "initialize":
      write({ id: msg.id, result: { serverInfo: { name: "muse", version: "1.4.7" }, grantedCapabilities: ["sessionMcp"], museHome: join(dataHome, "muse") } });
      return;
    case "session/start":
    case "session/resume":
      write({ id: msg.id, result: { session: { sessionId, status: "idle", providerId: "echo", modelId: null } } });
      return;
    case "turn/start": {
      if (process.env.FAKE_DELIVERY_REFUSE_ONCE === "1") {
        delete process.env.FAKE_DELIVERY_REFUSE_ONCE;
        write({id: msg.id, error: {code: -32600, message: "fixture refused before acceptance"}});
        return;
      }
      const turnId = msg.params.commandId;
      write({ id: msg.id, result: { commandId: turnId, disposition: "started", status: "accepted", turnId } });
      setTimeout(() => runTurn(turnId), 10);
      return;
    }
    default:
      if (msg.id !== undefined) write({ id: msg.id, result: {} });
  }
}).on("close", () => {
  notify("session/closed", { reason: "hostShutdown" });
  process.exit(0);
});
