#!/usr/bin/env node
import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith("/test-agent/fake-codex.mjs")) {
    result.source = String(result.source).replace('    case "initialize":', `    case "account/rateLimits/read":
      emit({id: msg.id, result: {rateLimits: {primary: {usedPercent: 5, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+14400}, secondary: {usedPercent: 5, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000)+518400}}}});
      return;
    case "initialize":`);
  }
  return result;
}});
await import("../../v2/driver-hsr/test-agent/fake-codex.mjs");
