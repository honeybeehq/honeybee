import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const child = spawn(process.execPath, [new URL("../../v2/driver-hsr/test-agent/fake-claude.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
createInterface({ input: child.stdout }).on("line", line => {
  process.stdout.write(line + "\n");
  const row = JSON.parse(line);
  if (row.type === "result" && !row.is_error && process.env.CLAUDE_CONFIG_DIR?.endsWith("claude-a")) setTimeout(() => {
    process.stdout.write(JSON.stringify({type:"rate_limit_event",rate_limit_info:{status:"rejected",rateLimitType:"weekly",resetsAt:1893456000}}) + "\n");
  }, 200);
});
child.on("exit", code => process.exit(code ?? 0));
process.on("SIGTERM", () => child.kill("SIGTERM"));
