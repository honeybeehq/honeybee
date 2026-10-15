import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const session = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : randomUUID();
const access = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "utf8")).claudeAiOauth.accessToken;
const MAX_CONNECTION_FAILURES = 20;
const parentPid = process.ppid;
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const ownerPid = Number(process.env.AUTH_DEATH_OWNER_PID ?? "");
const lease = process.env.HIVE_TEST_FIXTURE_LEASE ?? "";
const leaseOwner = Number(lease.slice(0, lease.indexOf(":")));
const leaseDir = lease.slice(lease.indexOf(":") + 1);
const orphaned = () =>
  process.ppid !== parentPid ||
  (Number.isSafeInteger(ownerPid) && ownerPid > 1 && !alive(ownerPid)) ||
  (lease !== "" && (!Number.isSafeInteger(leaseOwner) || leaseOwner <= 1 || !alive(leaseOwner) || !existsSync(leaseDir)));
if (orphaned()) process.exit(1);
if (process.env.AUTH_DEATH_PID_DIR) {
  mkdirSync(process.env.AUTH_DEATH_PID_DIR, { recursive: true });
  const birth = execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim().replace(/\s+/g, " ");
  writeFileSync(join(process.env.AUTH_DEATH_PID_DIR, String(process.pid)), birth);
}
let connectionFailures = 0;
const emit = value => process.stdout.write(JSON.stringify({ ...value, session_id: session }) + "\n");
let failed = false;
const probe = async () => {
  if (failed) return false;
  let response;
  try {
    response = await fetch(process.env.AUTH_DEATH_PROVIDER_URL, { headers: { authorization: `Bearer ${access}` } });
  } catch (error) {
    if (++connectionFailures >= MAX_CONNECTION_FAILURES) process.exit(1);
    throw error;
  }
  if (response.status !== 200 && response.status !== 401) {
    if (++connectionFailures >= MAX_CONNECTION_FAILURES) process.exit(1);
    return false;
  }
  connectionFailures = 0;
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
  if (orphaned()) process.exit(1);
  if (polling) return;
  polling = true;
  try {
    if (await probe() && !failed && process.env.AUTH_DEATH_STAY_ALIVE === "1") {
      emit({ type: "assistant", message: { role: "assistant", model: "fake", content: [{ type: "text", text: "Provider heartbeat" }] } });
      emit({ type: "result", subtype: "success", is_error: false, result: "Ready" });
    }
  } catch {} finally { polling = false; }
}, 100);
createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", async raw => {
  const message = JSON.parse(raw);
  if (message.type !== "user" || !await probe()) return;
  emit({ type: "assistant", message: { role: "assistant", model: "fake", content: [{ type: "text", text: "Completed" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "Completed" });
});
