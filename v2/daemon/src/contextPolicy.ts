import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_HOME_DEFAULT_MODEL } from "./homeDefaults.ts";

export class ContextPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextPolicyError";
  }
}

export const CONTEXT_WINDOWS = ["1m", "200k"] as const;
export type ContextWindow = (typeof CONTEXT_WINDOWS)[number];

export const CONTEXT_WINDOW_TOKENS: Record<ContextWindow, number> = { "1m": 1_000_000, "200k": 200_000 };
export const AUTO_COMPACT_WINDOW_MIN = 100_000;
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000;
export const CLAUDE_AUTO_COMPACT_SUMMARY_BUFFER = 13_000;
export const WORKSPACE_TAG_PREFIX = "apiary:workspace=";

export const CLAUDE_CONTEXT_ENV = {
  disable1m: "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  autoCompactWindow: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  autoCompactPercent: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
} as const;

export interface ContextPolicy {
  window?: ContextWindow;
  autoCompactWindow?: number;
  autoCompactPercent?: number;
}

export interface ContextPolicyConfig {
  default?: ContextPolicy;
  workspaces?: Record<string, ContextPolicy>;
}

export interface ContextPolicyFacts {
  window: ContextWindow | null;
  windowTokens: number | null;
  autoCompactWindow: number | null;
  autoCompactPercent: number | null;
  thresholdTokens: number | null;
}

export function contextPolicyOf(raw: unknown, where: string): ContextPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ContextPolicyError(`${where} must be an object`);
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (key !== "window" && key !== "autoCompactWindow" && key !== "autoCompactPercent") {
      throw new ContextPolicyError(`${where}.${key} is not a context policy field (window, autoCompactWindow, autoCompactPercent)`);
    }
  }
  const policy: ContextPolicy = {};
  if (value.window !== undefined) {
    if (!CONTEXT_WINDOWS.includes(value.window as ContextWindow)) throw new ContextPolicyError(`${where}.window must be one of ${CONTEXT_WINDOWS.join("|")}`);
    policy.window = value.window as ContextWindow;
  }
  if (value.autoCompactWindow !== undefined) {
    const n = value.autoCompactWindow;
    if (typeof n !== "number" || !Number.isInteger(n) || n < AUTO_COMPACT_WINDOW_MIN || n > AUTO_COMPACT_WINDOW_MAX) {
      throw new ContextPolicyError(`${where}.autoCompactWindow must be an integer from ${AUTO_COMPACT_WINDOW_MIN} to ${AUTO_COMPACT_WINDOW_MAX}`);
    }
    policy.autoCompactWindow = n;
  }
  if (value.autoCompactPercent !== undefined) {
    const n = value.autoCompactPercent;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 100) {
      throw new ContextPolicyError(`${where}.autoCompactPercent must be an integer from 1 to 100`);
    }
    policy.autoCompactPercent = n;
  }
  return policy;
}

export function contextPolicyConfigOf(raw: Record<string, unknown>): ContextPolicyConfig {
  const v = raw.contextPolicy;
  if (v === undefined) return {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ContextPolicyError("config: contextPolicy must be an object");
  const value = v as Record<string, unknown>;
  const config: ContextPolicyConfig = {};
  if (value.default !== undefined) config.default = contextPolicyOf(value.default, "config: contextPolicy.default");
  if (value.workspaces !== undefined) {
    if (value.workspaces === null || typeof value.workspaces !== "object" || Array.isArray(value.workspaces)) {
      throw new ContextPolicyError("config: contextPolicy.workspaces must be an object");
    }
    const workspaces: Record<string, ContextPolicy> = {};
    for (const [id, policy] of Object.entries(value.workspaces as Record<string, unknown>)) {
      workspaces[id] = contextPolicyOf(policy, `config: contextPolicy.workspaces.${id}`);
    }
    config.workspaces = workspaces;
  }
  return config;
}

function isEmpty(policy: ContextPolicy | null | undefined): boolean {
  return !policy || Object.keys(policy).length === 0;
}

export function storedContextPolicy(config: ContextPolicyConfig, workspace: string | null): ContextPolicy | null {
  const policy = workspace === null ? config.default : config.workspaces?.[workspace];
  return isEmpty(policy) ? null : { ...policy };
}

export function effectiveContextPolicy(config: ContextPolicyConfig, workspace: string | null): ContextPolicy {
  return { ...(config.default ?? {}), ...(workspace === null ? {} : (config.workspaces?.[workspace] ?? {})) };
}

export function sameContextPolicy(a: ContextPolicy | null, b: ContextPolicy | null): boolean {
  return (a?.window ?? null) === (b?.window ?? null)
    && (a?.autoCompactWindow ?? null) === (b?.autoCompactWindow ?? null)
    && (a?.autoCompactPercent ?? null) === (b?.autoCompactPercent ?? null);
}

export function writeContextPolicy(configPath: string, workspace: string | null, policy: ContextPolicy | null): ContextPolicyConfig {
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new ContextPolicyError(`config: ${configPath} is not valid json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ContextPolicyError(`config: ${configPath} must contain a json object`);
    }
    raw = parsed as Record<string, unknown>;
  }
  const current = contextPolicyConfigOf(raw);
  const next: ContextPolicyConfig = { ...current, workspaces: { ...(current.workspaces ?? {}) } };
  if (workspace === null) {
    if (isEmpty(policy)) delete next.default;
    else next.default = { ...policy };
  } else if (isEmpty(policy)) {
    delete next.workspaces![workspace];
  } else {
    next.workspaces![workspace] = { ...policy };
  }
  if (Object.keys(next.workspaces!).length === 0) delete next.workspaces;
  if (Object.keys(next).length === 0) delete raw.contextPolicy;
  else raw.contextPolicy = next;
  const tmp = `${configPath}.${process.pid}.tmp`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
  return next;
}

export function workspaceOfTags(tags: readonly string[]): string | null {
  const tag = tags.find((t) => t.startsWith(WORKSPACE_TAG_PREFIX) && t.length > WORKSPACE_TAG_PREFIX.length);
  return tag ? tag.slice(WORKSPACE_TAG_PREFIX.length) : null;
}

export function contextPolicyFacts(policy: ContextPolicy): ContextPolicyFacts {
  const windowTokens = policy.window ? CONTEXT_WINDOW_TOKENS[policy.window] : null;
  const autoCompactWindow = policy.autoCompactWindow ?? (policy.window === "200k" ? CONTEXT_WINDOW_TOKENS["200k"] : null);
  const autoCompactPercent = policy.autoCompactPercent ?? null;
  let thresholdTokens: number | null = null;
  if (autoCompactWindow !== null) {
    const effective = windowTokens === null ? autoCompactWindow : Math.min(autoCompactWindow, windowTokens);
    const buffered = effective - CLAUDE_AUTO_COMPACT_SUMMARY_BUFFER;
    thresholdTokens = autoCompactPercent === null ? buffered : Math.min(Math.floor(effective * (autoCompactPercent / 100)), buffered);
  }
  return { window: policy.window ?? null, windowTokens, autoCompactWindow, autoCompactPercent, thresholdTokens };
}

export function modelForWindow(model: string, window: ContextWindow): string {
  const base = model.replace(/\[1m\]/giu, "").trim();
  return window === "1m" ? `${base}[1m]` : base;
}

export function argValue(args: readonly string[], flag: string): string | undefined {
  let value: string | undefined;
  args.forEach((arg, i) => {
    if (arg === flag && i + 1 < args.length) value = args[i + 1];
    else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
  });
  return value;
}

export function claudeHomeModel(env: Record<string, string | undefined>): string | undefined {
  const home = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : join(env.HOME ?? homedir(), ".claude");
  try {
    const parsed = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const model = (parsed as Record<string, unknown>).model;
      if (typeof model === "string" && model.trim().length > 0) return model.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface ClaudeContextLaunch {
  modelArgs: string[];
  env: Record<string, string>;
  unset: string[];
}

export function claudeContextLaunch(
  policy: ContextPolicy,
  args: readonly string[],
  env: Record<string, string | undefined>,
  beeEnv: Record<string, string> | null,
): ClaudeContextLaunch {
  const pinned = new Set(Object.keys(beeEnv ?? {}));
  const out: ClaudeContextLaunch = { modelArgs: [], env: {}, unset: [] };
  const set = (key: string, value: string): void => { if (!pinned.has(key)) out.env[key] = value; };
  const facts = contextPolicyFacts(policy);
  if (policy.window) {
    const base = argValue(args, "--model") ?? claudeHomeModel(env) ?? CLAUDE_HOME_DEFAULT_MODEL;
    out.modelArgs = ["--model", modelForWindow(base, policy.window)];
    if (policy.window === "200k") set(CLAUDE_CONTEXT_ENV.disable1m, "1");
    else if (!pinned.has(CLAUDE_CONTEXT_ENV.disable1m)) out.unset.push(CLAUDE_CONTEXT_ENV.disable1m);
  }
  if (facts.autoCompactWindow !== null) set(CLAUDE_CONTEXT_ENV.autoCompactWindow, String(facts.autoCompactWindow));
  if (facts.autoCompactPercent !== null) set(CLAUDE_CONTEXT_ENV.autoCompactPercent, String(facts.autoCompactPercent));
  return out;
}
