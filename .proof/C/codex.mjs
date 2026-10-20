#!/usr/bin/env node
import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith("/test-agent/fake-codex.mjs")) {
    const source = String(result.source);
    result.source = source.replace('import { appendFileSync,', 'import { readFileSync as cReadFileSync, appendFileSync,').replace('    case "initialize":', `    case "account/rateLimits/read":
      if (process.env.C_CODEX_UNKNOWN_USAGE_FILE) {
        const fixture = JSON.parse(cReadFileSync(process.env.C_CODEX_UNKNOWN_USAGE_FILE, "utf8"));
        const account = process.env.CODEX_HOME?.split("/").at(-1);
        if (account !== "codex-a" && account !== "codex-b") throw new Error("unexpected lab Codex home");
        const at = Date.now();
        const used = account === "codex-a" && at >= fixture.recoverAt ? 5 : 100;
        appendFileSync(fixture.log, JSON.stringify({account, at, used, resetsAt: null}) + "\\n");
        emit({id: msg.id, result: {rateLimits: {primary: {usedPercent: used, windowDurationMins: 300, resetsAt: null}, secondary: {usedPercent: used, windowDurationMins: 10080, resetsAt: null}}}});
        return;
      }
      emit({id: msg.id, result: {rateLimits: {primary: {usedPercent: 5, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+14400}, secondary: {usedPercent: 5, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000)+518400}}}});
      return;
    case "initialize":`);
    if (!source.includes('    case "initialize":')) throw new Error("Codex fixture probe patch no longer matches");
    if (!source.includes('import { appendFileSync,')) throw new Error("Codex fixture import patch no longer matches");
    if (process.env.C_CODEX_UNKNOWN_USAGE_FILE) {
      const before = String(result.source);
      result.source = before.replace('if (quotaMode && quotaMode !== "text_fallback") {', 'if (quotaMode && quotaMode !== "text_fallback" && !process.env.C_CODEX_UNKNOWN_USAGE_FILE) {');
      if (result.source === before) throw new Error("Codex native unknown-reset patch no longer matches");
    }
  }
  return result;
}});
await import("../../v2/driver-hsr/test-agent/fake-codex.mjs");
