import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const session = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : randomUUID();
const access = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "utf8")).claudeAiOauth.accessToken;
const emit = value => process.stdout.write(JSON.stringify({ ...value, session_id: session }) + "\n");
let failed = false;
const probe = async () => {
  if (failed) return false;
  const response = await fetch(process.env.AUTH_DEATH_PROVIDER_URL, { headers: { authorization: `Bearer ${access}` } });
  if (failed) return false;
  if (response.status !== 401) return true;
  failed = true;
  emit({ type: "assistant", error: "authentication_failed", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "OAuth token revoked" }] } });
  emit({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 401, result: "OAuth token revoked" });
  if (process.env.AUTH_DEATH_STAY_ALIVE !== "1") process.stdout.write("", () => process.exit(1));
  return false;
};
emit({ type: "system", subtype: "init", tools: [], model: "fake" });
emit({ type: "result", subtype: "success", is_error: false, result: "Ready" });
let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    if (await probe() && !failed && process.env.AUTH_DEATH_STAY_ALIVE === "1") {
      emit({ type: "assistant", message: { role: "assistant", model: "fake", content: [{ type: "text", text: "Provider heartbeat" }] } });
      emit({ type: "result", subtype: "success", is_error: false, result: "Ready" });
    }
  } catch {} finally { polling = false; }
}, 100);
createInterface({ input: process.stdin }).on("line", async raw => {
  const message = JSON.parse(raw);
  if (message.type !== "user" || !await probe()) return;
  emit({ type: "assistant", message: { role: "assistant", model: "fake", content: [{ type: "text", text: "Completed" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "Completed" });
});
