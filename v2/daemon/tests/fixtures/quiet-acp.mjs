#!/usr/bin/env node
import { createInterface } from "node:readline";
const emit = row => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...row }) + "\n");
createInterface({ input: process.stdin }).on("line", raw => {
  const row = JSON.parse(raw);
  const ok = result => emit({ id: row.id, result });
  switch (row.method) {
    case "initialize":
      ok({ protocolVersion: 1, authMethods: [{ id: "fixture" }], agentCapabilities: { loadSession: true } });
      return;
    case "authenticate":
    case "session/set_config_option":
      ok({});
      return;
    case "session/new":
    case "session/resume":
      ok({ sessionId: "quiet-acp-root", configOptions: [{ id: "model", currentValue: "fixture" }, { id: "mode", currentValue: "default" }] });
      return;
    case "session/prompt": {
      const text = row.params.prompt[0].text;
      const chunk = (sessionId, text) => emit({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      chunk("quiet-acp-root", text.includes("@content-quiet") ? "done <quiet/>" : "<quiet/>");
      chunk("quiet-acp-child", "Child asks for review");
      if (text.includes("@error")) emit({ id: row.id, error: { code: -32000, message: "fixture failure" } });
      else ok({ stopReason: text.includes("@cancelled") ? "cancelled" : text.includes("@refusal") ? "refusal" : "end_turn" });
      return;
    }
  }
});
