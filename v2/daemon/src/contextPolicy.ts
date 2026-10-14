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
export const CLAUDE_AUTO_COMPACT_OUTPUT_RESERVE = 20_000;
export const WORKSPACE_TAG_PREFIX = "apiary:workspace=";
export const ROLE_TAG_PREFIX = "apiary:role=";
export const CONTEXT_ROLES = ["champion"] as const;
export type ContextRole = (typeof CONTEXT_ROLES)[number];
export const CHAMPION_AUTO_COMPACT_THRESHOLD = 650_000;
export const BUILTIN_ROLE_THRESHOLD: Record<ContextRole, number> = { champion: CHAMPION_AUTO_COMPACT_THRESHOLD };

export interface ClaudeLaunchFacts {
  homeAutoCompactWindow: number | null;
  envAutoCompactWindow: number | null;
  maxOutputTokens: number | null;
}

export const NO_LAUNCH_FACTS: ClaudeLaunchFacts = { homeAutoCompactWindow: null, envAutoCompactWindow: null, maxOutputTokens: null };

const CLAUDE_EXPONENT_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/;
const CLAUDE_GROUPED_NUMBER = /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/;

export function claudeEnvAutoCompactWindow(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (text.length === 0) return null;
  let n: number;
  if (text.length <= 32 && CLAUDE_EXPONENT_NUMBER.test(text)) {
    n = Number(text);
    if (!Number.isInteger(n)) return null;
  } else if (text.length <= 32 && CLAUDE_GROUPED_NUMBER.test(text)) {
    n = parseInt(text.replace(/[_,\u00A0\u202F ]/gu, ""), 10);
  } else {
    n = parseInt(text, 10);
  }
  if (Number.isNaN(n) || n <= 0) return null;
  return Math.min(AUTO_COMPACT_WINDOW_MAX, Math.max(AUTO_COMPACT_WINDOW_MIN, n));
}

export function builtinRoleContextPolicy(role: ContextRole, launch: ClaudeLaunchFacts = NO_LAUNCH_FACTS): ContextPolicy {
  const reserve = Math.min(launch.maxOutputTokens ?? CLAUDE_AUTO_COMPACT_OUTPUT_RESERVE, CLAUDE_AUTO_COMPACT_OUTPUT_RESERVE);
  return { autoCompactWindow: BUILTIN_ROLE_THRESHOLD[role] + CLAUDE_AUTO_COMPACT_SUMMARY_BUFFER + reserve };
}

export type ContextPolicyScope = { workspace: string } | { role: ContextRole } | null;

export function isContextRole(value: unknown): value is ContextRole {
  return CONTEXT_ROLES.includes(value as ContextRole);
}
const RESERVED_WORKSPACE_IDS = new Set(["__proto__", "constructor", "prototype"]);

export function validWorkspaceId(id: string): boolean {
  return id.length > 0 && !RESERVED_WORKSPACE_IDS.has(id);
}

function workspacePolicy(config: ContextPolicyConfig, workspace: string): ContextPolicy | undefined {
  return config.workspaces && Object.hasOwn(config.workspaces, workspace) ? config.workspaces[workspace] : undefined;
}

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
  roles?: Partial<Record<ContextRole, ContextPolicy>>;
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
  if (value.roles !== undefined) {
    if (value.roles === null || typeof value.roles !== "object" || Array.isArray(value.roles)) {
      throw new ContextPolicyError("config: contextPolicy.roles must be an object");
    }
    const roles: Partial<Record<ContextRole, ContextPolicy>> = {};
    for (const [role, policy] of Object.entries(value.roles as Record<string, unknown>)) {
      if (!isContextRole(role)) throw new ContextPolicyError(`config: contextPolicy.roles.${role} is not a role (${CONTEXT_ROLES.join("|")})`);
      roles[role] = contextPolicyOf(policy, `config: contextPolicy.roles.${role}`);
    }
    config.roles = roles;
  }
  if (value.workspaces !== undefined) {
    if (value.workspaces === null || typeof value.workspaces !== "object" || Array.isArray(value.workspaces)) {
      throw new ContextPolicyError("config: contextPolicy.workspaces must be an object");
    }
    const workspaces: Record<string, ContextPolicy> = {};
    for (const [id, policy] of Object.entries(value.workspaces as Record<string, unknown>)) {
      if (!validWorkspaceId(id)) throw new ContextPolicyError(`config: contextPolicy.workspaces.${id} is not a valid workspace id`);
      workspaces[id] = contextPolicyOf(policy, `config: contextPolicy.workspaces.${id}`);
    }
    config.workspaces = workspaces;
  }
  return config;
}

function isEmpty(policy: ContextPolicy | null | undefined): boolean {
  return !policy || Object.keys(policy).length === 0;
}

function scopedPolicy(config: ContextPolicyConfig, scope: ContextPolicyScope): ContextPolicy | undefined {
  if (scope === null) return config.default;
  if ("role" in scope) return config.roles?.[scope.role];
  return workspacePolicy(config, scope.workspace);
}

export function storedContextPolicy(config: ContextPolicyConfig, scope: ContextPolicyScope): ContextPolicy | null {
  const policy = scopedPolicy(config, scope);
  return isEmpty(policy) ? null : { ...policy };
}

export function roleContextPolicy(config: ContextPolicyConfig, role: ContextRole, launch: ClaudeLaunchFacts = NO_LAUNCH_FACTS): ContextPolicy {
  const stored = storedContextPolicy(config, { role });
  if (stored) return stored;
  const lower = [config.default?.autoCompactWindow, launch.homeAutoCompactWindow ?? undefined, launch.envAutoCompactWindow ?? undefined].filter((n): n is number => typeof n === "number");
  return { autoCompactWindow: Math.min(builtinRoleContextPolicy(role, launch).autoCompactWindow!, ...lower) };
}

export function effectiveContextPolicy(config: ContextPolicyConfig, workspace: string | null, role: ContextRole | null = null, launch: ClaudeLaunchFacts = NO_LAUNCH_FACTS): ContextPolicy {
  return {
    ...(config.default ?? {}),
    ...(role === null ? {} : roleContextPolicy(config, role, launch)),
    ...(workspace === null ? {} : (workspacePolicy(config, workspace) ?? {})),
  };
}

export function sameContextPolicy(a: ContextPolicy | null, b: ContextPolicy | null): boolean {
  return (a?.window ?? null) === (b?.window ?? null)
    && (a?.autoCompactWindow ?? null) === (b?.autoCompactWindow ?? null)
    && (a?.autoCompactPercent ?? null) === (b?.autoCompactPercent ?? null);
}

export function writeContextPolicy(configPath: string, scope: ContextPolicyScope, policy: ContextPolicy | null): ContextPolicyConfig {
  if (scope !== null && "workspace" in scope && !validWorkspaceId(scope.workspace)) throw new ContextPolicyError(`contextPolicy: '${scope.workspace}' is not a valid workspace id`);
  if (scope !== null && "role" in scope && !isContextRole(scope.role)) throw new ContextPolicyError(`contextPolicy: '${String(scope.role)}' is not a role`);
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
  const next: ContextPolicyConfig = { ...current, roles: { ...(current.roles ?? {}) }, workspaces: { ...(current.workspaces ?? {}) } };
  if (scope === null) {
    if (isEmpty(policy)) delete next.default;
    else next.default = { ...policy };
  } else if ("role" in scope) {
    if (isEmpty(policy)) delete next.roles![scope.role];
    else next.roles![scope.role] = { ...policy };
  } else if (isEmpty(policy)) {
    delete next.workspaces![scope.workspace];
  } else {
    next.workspaces![scope.workspace] = { ...policy };
  }
  if (Object.keys(next.roles!).length === 0) delete next.roles;
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
  const tag = tags.find((t) => t.startsWith(WORKSPACE_TAG_PREFIX) && validWorkspaceId(t.slice(WORKSPACE_TAG_PREFIX.length)));
  return tag ? tag.slice(WORKSPACE_TAG_PREFIX.length) : null;
}

export function roleOfTags(tags: readonly string[]): ContextRole | null {
  const tag = tags.find((t) => t.startsWith(ROLE_TAG_PREFIX) && isContextRole(t.slice(ROLE_TAG_PREFIX.length)));
  return tag ? (tag.slice(ROLE_TAG_PREFIX.length) as ContextRole) : null;
}

export function contextPolicyFacts(policy: ContextPolicy, launch: ClaudeLaunchFacts = NO_LAUNCH_FACTS): ContextPolicyFacts {
  const windowTokens = policy.window ? CONTEXT_WINDOW_TOKENS[policy.window] : null;
  const autoCompactWindow = policy.window === "200k"
    ? Math.min(policy.autoCompactWindow ?? CONTEXT_WINDOW_TOKENS["200k"], CONTEXT_WINDOW_TOKENS["200k"])
    : (policy.autoCompactWindow ?? null);
  const autoCompactPercent = policy.autoCompactPercent ?? null;
  let thresholdTokens: number | null = null;
  if (autoCompactWindow !== null) {
    const reserve = Math.min(launch.maxOutputTokens ?? CLAUDE_AUTO_COMPACT_OUTPUT_RESERVE, CLAUDE_AUTO_COMPACT_OUTPUT_RESERVE);
    const effective = (windowTokens === null ? autoCompactWindow : Math.min(autoCompactWindow, windowTokens)) - reserve;
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

function claudeHomeSettings(env: Record<string, string | undefined>): Record<string, unknown> {
  const home = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : join(env.HOME ?? homedir(), ".claude");
  try {
    const parsed = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function claudeHomeModel(env: Record<string, string | undefined>): string | undefined {
  const model = claudeHomeSettings(env).model;
  return typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined;
}

export function claudeLaunchFacts(env: Record<string, string | undefined>): ClaudeLaunchFacts {
  const window = claudeHomeSettings(env).autoCompactWindow;
  const maxOutput = Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  return {
    homeAutoCompactWindow: typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null,
    envAutoCompactWindow: claudeEnvAutoCompactWindow(env[CLAUDE_CONTEXT_ENV.autoCompactWindow]),
    maxOutputTokens: Number.isInteger(maxOutput) && maxOutput > 0 ? maxOutput : null,
  };
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
