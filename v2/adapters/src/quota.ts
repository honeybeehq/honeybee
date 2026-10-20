import type { QuotaBoundary } from "../../core/src/quota.ts";
import { createHash } from "node:crypto";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function reset(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = Math.round(value * 1000);
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
}

function windowKind(value: unknown): QuotaBoundary["window"] {
  if (value === "seven_day" || value === "seven_day_opus" || value === "seven_day_sonnet") return "weekly";
  return value === "five_hour" || value === "weekly" ? value : "other";
}

export function claudeQuotaBoundary(row: Record<string, unknown>): QuotaBoundary | undefined {
  if (row.type === "rate_limit_event") {
    const info = object(row.rate_limit_info);
    if (!info || (info.status !== "rejected" && info.status !== "blocked")) return undefined;
    return { harness: "claude", window: windowKind(info.rateLimitType), resetsAt: reset(info.resetsAt), providerCategory: "rate_limit_event" };
  }
  const message = object(row.message);
  const synthetic = row.type === "assistant" && (message?.model === "<synthetic>" || row.error === "rate_limit");
  const errored = row.type === "result" && row.is_error === true;
  if (!synthetic && !errored) return undefined;
  const content = message?.content;
  const block = Array.isArray(content) && content.length === 1 ? object(content[0]) : undefined;
  const text = errored ? row.result : typeof content === "string" ? content : block?.type === "text" ? block.text : undefined;
  if (typeof text !== "string") return undefined;
  const match = /^You've hit your (?:(weekly|5-hour|five-hour) )?limit · resets ([^\r\n]+)$/.exec(text);
  if (!match) return undefined;
  const absolute = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(match[2]!) ? Date.parse(match[2]!) : NaN;
  return { harness: "claude", window: match[1] === "weekly" ? "weekly" : "five_hour", resetsAt: Number.isFinite(absolute) ? absolute : null, providerCategory: synthetic ? "synthetic_limit" : "errored_result_limit" };
}

export function codexQuotaBoundary(row: Record<string, unknown>): QuotaBoundary | undefined {
  const params = object(row.params);
  if (!params) return undefined;
  if (row.method === "account/rateLimits/updated") {
    const snapshot = object(params.rateLimits);
    const reached = snapshot?.rateLimitReachedType;
    if (reached === null || reached === undefined) return undefined;
    const primary = object(snapshot?.primary);
    const secondary = object(snapshot?.secondary);
    const exhausted = [primary, secondary].filter(value => value !== undefined && typeof value.usedPercent === "number" && value.usedPercent >= 100);
    exhausted.sort((a, b) => (reset(b?.resetsAt) ?? Number.MAX_SAFE_INTEGER) - (reset(a?.resetsAt) ?? Number.MAX_SAFE_INTEGER));
    const target = exhausted[0];
    const minutes = target?.windowDurationMins;
    return { harness: "codex", window: minutes === 300 ? "five_hour" : minutes === 10080 ? "weekly" : windowKind(reached), resetsAt: reset(target?.resetsAt), providerCategory: "rateLimitReachedType" };
  }
  const error = row.method === "error" ? object(params.error) : row.method === "turn/completed" ? object(object(params.turn)?.error) : undefined;
  if (error?.codexErrorInfo !== "usageLimitExceeded") return undefined;
  return { harness: "codex", window: "other", resetsAt: null, providerCategory: "usageLimitExceeded" };
}

export function quotaSourceId(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}
