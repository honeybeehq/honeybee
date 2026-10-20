import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith("/test-agent/fake-claude.mjs") && process.env.C_UNKNOWN_RESET === "1") {
    result.source = String(result.source).replace('const resets = quotaMode === "weekly_local"', 'const resets = true');
  }
  return result;
}});
await import("../../v2/driver-hsr/test-agent/fake-claude.mjs");
