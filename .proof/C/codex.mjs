#!/usr/bin/env node
import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith("/test-agent/fake-codex.mjs")) {
    const source = String(result.source);
    result.source = source.replace('    case "initialize":', `    case "account/rateLimits/read":
      emit({id: msg.id, result: {rateLimits: {primary: {usedPercent: 5, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+14400}, secondary: {usedPercent: 5, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000)+518400}}}});
      return;
    case "initialize":`);
    if (result.source === source) throw new Error("Codex fixture probe patch no longer matches");
  }
  return result;
}});
await import("../../v2/driver-hsr/test-agent/fake-codex.mjs");
