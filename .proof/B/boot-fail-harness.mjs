import { existsSync, writeFileSync } from "node:fs";
const marker = process.env.B_BOOT_ONCE_PATH;
if (process.env.CLAUDE_CONFIG_DIR?.endsWith("claude-b") && marker && !existsSync(marker)) {
  writeFileSync(marker, "successor failed before provider output");
  await new Promise(resolve => setTimeout(resolve, Number(process.env.B_BOOT_DELAY_MS ?? 0)));
  process.exit(1);
}
await import("../../v2/driver-hsr/test-agent/fake-claude.mjs");
