#!/usr/bin/env node
/**
 * A one-tool stdio MCP server for the live smoke: `smoke_echo {text}` answers
 * `echo:<text>` and appends the call to SMOKE_MCP_LOG, so the smoke can prove
 * the harness reached a session MCP server. No dependencies, no network.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const note = (entry) => {
  if (process.env.SMOKE_MCP_LOG) appendFileSync(process.env.SMOKE_MCP_LOG, `${JSON.stringify(entry)}\n`);
};

createInterface({ input: process.stdin }).on("line", (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  switch (msg.method) {
    case "initialize":
      note({ method: "initialize" });
      write({ id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "honeybee-smoke", version: "1" },
      } });
      return;
    case "ping":
      write({ id: msg.id, result: {} });
      return;
    case "tools/list":
      write({ id: msg.id, result: { tools: [{
        name: "smoke_echo",
        description: "Echo the given text back. Used by the Honeybee smoke test.",
        inputSchema: { type: "object", properties: { text: { type: "string", description: "Text to echo" } }, required: ["text"] },
      }] } });
      return;
    case "tools/call": {
      const text = String(msg.params?.arguments?.text ?? "");
      note({ method: "tools/call", name: msg.params?.name, text });
      if (msg.params?.name !== "smoke_echo") {
        write({ id: msg.id, result: { content: [{ type: "text", text: `unknown tool ${msg.params?.name}` }], isError: true } });
        return;
      }
      write({ id: msg.id, result: { content: [{ type: "text", text: `echo:${text}` }] } });
      return;
    }
    default:
      write({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
