/**
 * agy print-mode adapter. agy emits NDJSON on stdout and accepts one NDJSON
 * user envelope per turn on stdin. The protocol was captured from agy 1.1.24
 * on 2026-09-02; unknown events remain replayable log noise.
 */
import {
  asObject,
  bootedToIdle,
  isAuthNeededMessage,
  isResourceBlockedMessage,
  nonEmptyString,
  parseJsonLine,
  successfulTurnClears,
  toNumber as finiteNumber,
  type AdapterSignal,
  type EncodeContext,
  type HarnessAdapter,
  type InterruptContext,
} from "./types.ts";
import {
  projectorCheckpoint, checkpointRecord, checkpointEntries, checkpointNullable,
  checkpointString, checkpointStrings, checkpointBoolean, checkpointNumber,
  type TranscriptFamily, type TranscriptProjectedEvent, type TranscriptProjector, type TranscriptTokenUsage,
} from "./transcript.ts";
import { createGrokProjector, isGrokCheckpointState, type GrokCheckpointState, type GrokMcpServerStdio } from "./grok.ts";

function resultSignals(resultValue: unknown): AdapterSignal[] {
  const result = asObject(resultValue);
  if (!result || typeof result.status !== "string") return [];

  if (result.status === "SUCCESS") {
    return [...successfulTurnClears(), { kind: "turn_ended" }];
  }

  if (result.status === "ERROR") {
    const message = typeof result.error === "string"
      ? result.error
      : typeof result.response === "string" && result.response.length > 0
        ? result.response
        : "agy result error";
    const signals: AdapterSignal[] = [];
    if (isAuthNeededMessage(message)) {
      signals.push({ kind: "flag", flag: "auth_needed", action: "set", detail: message.slice(0, 500) });
    } else if (isResourceBlockedMessage(message)) {
      signals.push({ kind: "flag", flag: "resource_blocked", action: "set", detail: message.slice(0, 500) });
    }
    signals.push({ kind: "turn_ended" });
    return signals;
  }

  // CANCELED is a normal terminal result. In request-review mode, a queued
  // next message can cancel a tool approval without crashing the process.
  return [{ kind: "turn_ended" }];
}

export function parseAgyLine(line: string): AdapterSignal[] {
  const message = parseJsonLine(line);
  if (!message || typeof message.event !== "string") return [];

  switch (message.event) {
    case "init": {
      const sessionId = typeof message.conversation_id === "string" && message.conversation_id.length > 0
        ? message.conversation_id
        : undefined;
      return bootedToIdle(sessionId);
    }
    case "step_update": {
      const update = asObject(message.step_update);
      return update?.step_type === "agent_response" ? [{ kind: "turn_started" }] : [];
    }
    case "result":
      return resultSignals(message.result);
    default:
      return [];
  }
}

/** One stream-json input line in the shape accepted by agy 1.1.24. */
export function encodeAgyMessage(body: string): string {
  return JSON.stringify({
    event: "user",
    message: { content: [{ type: "text", text: body }] },
  });
}

export function agyResumeArgs(providerSessionId: string): string[] {
  return ["--conversation", providerSessionId];
}

export const agyAdapter: HarnessAdapter = {
  harness: "agy",
  acceptsMidTurn: false,
  confirmsDelivery: false,
  readyAtSpawn: false,
  bootLines(): string[] {
    return [];
  },
  parseLine: parseAgyLine,
  encodeMessage(body: string, _ctx: EncodeContext): string | null {
    return encodeAgyMessage(body);
  },
  resumeArgs: agyResumeArgs,
};

export const AGY_ACP_SUBCOMMAND = "acp";
export const AGY_AUTH_METHOD_ENV = "HIVE_AGY_AUTH_METHOD";

export interface AgyAcpOptions {
  cwd: string;
  model?: string;
  effort?: string;
  mode?: string;
  allowPermissions: boolean;
  authMethodId?: string;
  resumeSessionId?: string;
  mcpServers?: readonly GrokMcpServerStdio[];
}

export type AgySpawnPlan =
  | { acp: false }
  | { acp: true; argv: string[]; model?: string; effort?: string; mode?: string; allowPermissions: boolean };

const AGY_PRINT_ONLY_VALUE_FLAGS = new Set(["--input-format", "--output-format", "--print-timeout", "--conversation", "--json-schema", "--project", "--settings"]);
const AGY_PRINT_ONLY_BOOLEAN_FLAGS = new Set(["--print", "--prompt", "-p", "--continue", "-c", "--new-project", "--remote-agent", "--remote-control", "--disable-slash-commands"]);
const AGY_ACP_VALUE_FLAGS = new Set(["--add-dir", "--agent", "--log-file", "--cli_log_file", "--gemini-dir", "--gemini_dir", "--app-data-dir", "--app_data_dir", "--cli_dir_name", "--cloud_code_endpoint", "--ide-mcp-port", "--ide_mcp_port", "--override_user_agent_name"]);

function flagParts(arg: string): { flag: string; inline?: string } {
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  return eq === -1 ? { flag: arg } : { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

export function agySpawnPlan(args: readonly string[], permissionArgs: readonly string[] = args): AgySpawnPlan {
  let acp = false;
  let model: string | undefined;
  let effort: string | undefined;
  let mode: string | undefined;
  const allowPermissions = permissionArgs.includes("--dangerously-skip-permissions");
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const { flag, inline } = flagParts(arg);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = args[i + 1];
      if (next === undefined) throw new Error(`agy ${flag} requires a value`);
      i += 1;
      return next;
    };
    if (arg === AGY_ACP_SUBCOMMAND) acp = true;
    else if (flag === "--model") model = value();
    else if (flag === "--effort") effort = value();
    else if (flag === "--mode") mode = value();
    else if (arg === "--dangerously-skip-permissions") continue;
    else if (AGY_PRINT_ONLY_VALUE_FLAGS.has(flag)) value();
    else if (AGY_PRINT_ONLY_BOOLEAN_FLAGS.has(flag)) continue;
    else if (AGY_ACP_VALUE_FLAGS.has(flag) && inline === undefined && args[i + 1] !== undefined) rest.push(arg, args[++i]!);
    else rest.push(arg);
  }
  if (!acp) return { acp: false };
  return {
    acp: true,
    argv: [AGY_ACP_SUBCOMMAND, ...rest],
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(mode ? { mode } : {}),
    allowPermissions,
  };
}

const AGY_ACP_INITIALIZE_ID = 1;
const AGY_ACP_AUTHENTICATE_ID = 2;
const AGY_ACP_SETUP_ID = 3;
export const AGY_ACP_PROMPT_ID_BASE = 1000;
const AGY_ACP_METHOD_NOT_FOUND = -32601;
const AGY_ACP_CONFIG_PREFIX = "agy:config:";

type AgyAcpConfigStep = "model" | "thought_level" | "mode";

function acpRequest(id: string | number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function acpFailure(message: string, startup: boolean): AdapterSignal[] {
  const flag = isAuthNeededMessage(message) ? "auth_needed"
    : isResourceBlockedMessage(message) ? "resource_blocked" : startup ? "spawn_failed" : undefined;
  return flag ? [{ kind: "flag", flag, action: "set", detail: message.slice(0, 500) }] : [];
}

export function agyPermissionAnswer(params: unknown, allow: boolean): Record<string, unknown> {
  const options = asObject(params)?.options;
  const rows = Array.isArray(options) ? options.map(asObject) : [];
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const option = rows.find((row) => row?.kind === kind && typeof row.optionId === "string");
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

export function agyAcpAdapter(opts: AgyAcpOptions): HarnessAdapter {
  const steps: Array<[AgyAcpConfigStep, string]> = [
    ...(opts.model ? [["model", opts.model] as [AgyAcpConfigStep, string]] : []),
    ...(opts.effort ? [["thought_level", opts.effort] as [AgyAcpConfigStep, string]] : []),
    ...(opts.mode ? [["mode", opts.mode] as [AgyAcpConfigStep, string]] : []),
  ];
  const setupMethod = opts.resumeSessionId ? "session/resume" : "session/new";
  const setupLine = acpRequest(AGY_ACP_SETUP_ID, setupMethod, {
    cwd: opts.cwd,
    mcpServers: opts.mcpServers?.map((server) => ({ ...server, args: [...server.args], env: server.env.map((entry) => ({ ...entry })) })) ?? [],
    ...(opts.resumeSessionId ? { sessionId: opts.resumeSessionId } : {}),
  });

  function configureFrom(index: number, sessionId: string): AdapterSignal[] {
    const step = steps[index];
    if (!step) return bootedToIdle(sessionId);
    const [configId, value] = step;
    return [{ kind: "respond", lines: [acpRequest(`${AGY_ACP_CONFIG_PREFIX}${index}:${sessionId}`, "session/set_config_option", { sessionId, configId, value })] }];
  }

  function responseSignals(row: Record<string, unknown>): AdapterSignal[] {
    const error = "error" in row ? String(asObject(row.error)?.message ?? "agy ACP request failed") : undefined;
    if (typeof row.id === "number" && row.id >= AGY_ACP_PROMPT_ID_BASE) {
      if (error !== undefined) return [...acpFailure(error, false), { kind: "turn_ended" }];
      if (!("result" in row)) return [];
      const stopReason = asObject(row.result)?.stopReason;
      return stopReason === "end_turn" || stopReason === undefined
        ? [...successfulTurnClears(), { kind: "turn_ended" }]
        : [{ kind: "turn_ended" }];
    }
    if (row.id === AGY_ACP_INITIALIZE_ID) {
      if (error !== undefined) return acpFailure(error, true);
      if (opts.resumeSessionId) {
        const result = asObject(row.result);
        const caps = asObject(result?.agentCapabilities);
        const sessions = asObject(caps?.sessionCapabilities ?? result?.sessionCapabilities);
        if (!sessions || !("resume" in sessions)) return acpFailure("Installed agy ACP does not advertise session/resume", true);
      }
      if (opts.authMethodId) return [{ kind: "respond", lines: [acpRequest(AGY_ACP_AUTHENTICATE_ID, "authenticate", { methodId: opts.authMethodId })] }];
      return [{ kind: "respond", lines: [setupLine] }];
    }
    if (row.id === AGY_ACP_AUTHENTICATE_ID) {
      if (error !== undefined) return [{ kind: "flag", flag: "auth_needed", action: "set", detail: error.slice(0, 500) }];
      return [{ kind: "respond", lines: [setupLine] }];
    }
    if (row.id === AGY_ACP_SETUP_ID) {
      if (error !== undefined) return acpFailure(error, true);
      const result = asObject(row.result);
      const sessionId = nonEmptyString(result?.sessionId) ?? opts.resumeSessionId;
      if (!sessionId) return acpFailure(`agy ${setupMethod} returned no sessionId`, true);
      return configureFrom(0, sessionId);
    }
    if (typeof row.id === "string" && row.id.startsWith(AGY_ACP_CONFIG_PREFIX)) {
      const rest = row.id.slice(AGY_ACP_CONFIG_PREFIX.length);
      const colon = rest.indexOf(":");
      const index = Number(rest.slice(0, colon));
      const sessionId = rest.slice(colon + 1);
      if (colon <= 0 || !Number.isSafeInteger(index) || !sessionId) return [];
      if (error !== undefined) {
        const step = steps[index];
        return acpFailure(step ? `agy rejected ${step[0]} ${step[1]}: ${error}` : error, true);
      }
      return configureFrom(index + 1, sessionId);
    }
    return [];
  }

  function methodSignals(row: Record<string, unknown>): AdapterSignal[] {
    if (row.id !== undefined && row.id !== null) {
      if (row.method === "session/request_permission") {
        return [{ kind: "respond", lines: [JSON.stringify({ jsonrpc: "2.0", id: row.id, result: agyPermissionAnswer(row.params, opts.allowPermissions) })] }];
      }
      return [{ kind: "respond", lines: [JSON.stringify({ jsonrpc: "2.0", id: row.id, error: { code: AGY_ACP_METHOD_NOT_FOUND, message: `unsupported client method: ${String(row.method)}` } })] }];
    }
    if (row.method !== "session/update") return [];
    const params = asObject(row.params);
    if (asObject(params?._meta)?.isReplay === true) return [];
    const kind = asObject(params?.update)?.sessionUpdate;
    return kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "tool_call" || kind === "tool_call_update"
      ? [{ kind: "turn_started" }]
      : [];
  }

  return {
    harness: "agy",
    acceptsMidTurn: false,
    readyAtSpawn: false,
    bootLines: () => [acpRequest(AGY_ACP_INITIALIZE_ID, "initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "Honeybee", version: "2" },
    })],
    parseLine(line: string): AdapterSignal[] {
      const row = parseJsonLine(line);
      if (!row) return [];
      return typeof row.method === "string" ? methodSignals(row) : responseSignals(row);
    },
    encodeMessage(body: string, ctx: EncodeContext): string | null {
      return ctx.sessionId
        ? acpRequest(AGY_ACP_PROMPT_ID_BASE + ctx.messageId, "session/prompt", { sessionId: ctx.sessionId, prompt: [{ type: "text", text: body }] })
        : null;
    },
    encodeInterrupt(ctx: InterruptContext): string | null {
      return ctx.sessionId ? JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: ctx.sessionId } }) : null;
    },
  };
}

/**
 * agy stream-json projection, captured from agy 1.1.24 on 2026-09-02.
 * HSR logs both the user envelopes written to stdin and agy's stdout lines.
 */
type JsonObject = Record<string, unknown>;
interface AssistantFragment {
  text: string;
  providerEventId?: string;
}

const TERMINAL_TOOL_STATES = new Set(["DONE", "ERROR", "FAILED", "CANCELED"]);
const ERROR_TOOL_STATES = new Set(["ERROR", "FAILED", "CANCELED"]);
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"] as const;

/** Each emitted-identity set retains its most recent distinct emissions in FIFO order. */
export const AGY_DEDUPE_LIMIT = 1024;

function rememberEmission(identities: Set<string>, id: string): void {
  identities.add(id);
  if (identities.size > AGY_DEDUPE_LIMIT) {
    const oldest = identities.values().next();
    if (!oldest.done) identities.delete(oldest.value);
  }
}

function isEmittedIdentities(value: unknown): boolean {
  return Array.isArray(value) && value.length <= AGY_DEDUPE_LIMIT && checkpointStrings(value);
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((entry) => {
    const block = asObject(entry);
    return block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0
      ? [block.text]
      : [];
  });
  return text.length > 0 ? text.join("\n") : undefined;
}

function usageFrom(value: unknown): TranscriptTokenUsage | undefined {
  const usage = asObject(value);
  if (!usage) return undefined;
  const input = finiteNumber(usage.input_tokens);
  const output = finiteNumber(usage.output_tokens);
  const cacheRead = finiteNumber(usage.cache_read_tokens);
  const cacheWrite = finiteNumber(usage.cache_write_tokens);
  const reasoning = finiteNumber(usage.thinking_tokens);
  const total = finiteNumber(usage.total_tokens);
  const projected: TranscriptTokenUsage = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(total !== undefined ? { total } : {}),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function usageDelta(
  current: TranscriptTokenUsage,
  previous: TranscriptTokenUsage | undefined,
  subtractPrevious: boolean,
): TranscriptTokenUsage {
  const projected: TranscriptTokenUsage = {};
  for (const key of USAGE_KEYS) {
    const value = current[key];
    if (value === undefined) continue;
    const before = previous?.[key];
    projected[key] = subtractPrevious && before !== undefined && value >= before
      ? value - before
      : value;
  }
  return projected;
}

function printableOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// checkpoint-digest:start
interface AgyCheckpointState {
  threadId: string | null;
  sawAssistantText: boolean;
  previousResultUsage: TranscriptTokenUsage | null;
  previousNumTurns: number | null;
  previousDurationSeconds: number | null;
  assistantFragments: Array<[string, AssistantFragment]>;
  emittedAssistantMessages: string[];
  emittedToolCalls: string[];
  emittedToolResults: string[];
  acp?: AgyAcpCheckpointState;
}

interface AgyAcpPermission {
  title: string;
  options: Array<[string, string]>;
}

interface AgyAcpCheckpointState {
  stream: GrokCheckpointState;
  model: string | null;
  effort: string | null;
  contextWindow: number | null;
  permissions: Array<[string, AgyAcpPermission]>;
}

export const AGY_ACP_PERMISSION_LIMIT = 64;

function isAgyAcpPermission(value: unknown): boolean {
  const v = asObject(value);
  return !!v && checkpointRecord(v, {
    title: checkpointString,
    options: (options) => Array.isArray(options) && options.every((entry) => Array.isArray(entry) && entry.length === 2 && checkpointString(entry[0]) && checkpointString(entry[1])),
  });
}

function isAgyAcpCheckpointState(value: unknown): boolean {
  return checkpointRecord(value, {
    stream: isGrokCheckpointState,
    model: checkpointNullable(checkpointString),
    effort: checkpointNullable(checkpointString),
    contextWindow: checkpointNullable(checkpointNumber),
    permissions: (entries) => Array.isArray(entries) && entries.length <= AGY_ACP_PERMISSION_LIMIT && checkpointEntries(isAgyAcpPermission)(entries),
  });
}

function acpUsageFrom(value: unknown): TranscriptTokenUsage | undefined {
  const usage = asObject(value);
  if (!usage) return undefined;
  const input = finiteNumber(usage.inputTokens);
  const output = finiteNumber(usage.outputTokens);
  const cacheRead = finiteNumber(usage.cachedReadTokens);
  const cacheWrite = finiteNumber(usage.cachedWriteTokens);
  const reasoning = finiteNumber(usage.thoughtTokens);
  const total = finiteNumber(usage.totalTokens);
  const projected: TranscriptTokenUsage = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(total !== undefined ? { total } : {}),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function isAcpRow(row: JsonObject): boolean {
  return row.jsonrpc !== undefined || typeof row.method === "string";
}

interface AgyAcpProjection {
  push(row: JsonObject, line: string): TranscriptProjectedEvent[];
  flush(): TranscriptProjectedEvent[];
  state(): AgyAcpCheckpointState;
}

function createAgyAcpProjection(restored?: AgyAcpCheckpointState): AgyAcpProjection {
  const stream = createGrokProjector(restored?.stream);
  let model = restored?.model ?? null;
  let effort = restored?.effort ?? null;
  let contextWindow = restored?.contextWindow ?? null;
  const permissions = new Map<string, AgyAcpPermission>(restored?.permissions);

  function trackOptions(value: unknown): void {
    if (!Array.isArray(value)) return;
    const options = value.map(asObject);
    const selected = options.find((option) => option?.id === "model")?.currentValue;
    if (typeof selected !== "string" || selected.length === 0) return;
    const level = options.find((option) => option?.id === "thought_level")?.currentValue;
    model = selected;
    effort = typeof level === "string" && level.length > 0 ? level : null;
  }

  function trackResult(result: JsonObject | undefined): void {
    if (!result) return;
    if (Array.isArray(result.configOptions)) {
      trackOptions(result.configOptions);
      return;
    }
    const current = nonEmptyString(asObject(result.models)?.currentModelId);
    if (current) {
      model = current;
      effort = null;
    }
  }

  function modelId(): string | undefined {
    if (!model) return undefined;
    return effort ? `${model}-${effort}` : model;
  }

  function rememberPermission(key: string, permission: AgyAcpPermission): void {
    permissions.delete(key);
    permissions.set(key, permission);
    if (permissions.size > AGY_ACP_PERMISSION_LIMIT) {
      const oldest = permissions.keys().next();
      if (!oldest.done) permissions.delete(oldest.value);
    }
  }

  function permissionRequested(row: JsonObject): TranscriptProjectedEvent[] {
    const params = asObject(row.params);
    const tool = asObject(params?.toolCall);
    const title = nonEmptyString(tool?.title) ?? nonEmptyString(tool?.name) ?? "tool";
    const options = (Array.isArray(params?.options) ? params.options : []).flatMap((raw): Array<[string, string]> => {
      const option = asObject(raw);
      const optionId = nonEmptyString(option?.optionId);
      return optionId ? [[optionId, nonEmptyString(option?.kind) ?? nonEmptyString(option?.name) ?? optionId]] : [];
    });
    rememberPermission(JSON.stringify(row.id), { title, options });
    const choices = options.map(([optionId, kind]) => `${optionId} (${kind})`).join(", ");
    return [...stream.flush(), { kind: "message", ts: null, role: "system", text: `Permission requested: ${title}${choices ? ` [${choices}]` : ""}` }];
  }

  function permissionAnswered(row: JsonObject, permission: AgyAcpPermission): TranscriptProjectedEvent[] {
    const outcome = asObject(asObject(row.result)?.outcome);
    const optionId = nonEmptyString(outcome?.optionId);
    const kind = optionId ? permission.options.find(([id]) => id === optionId)?.[1] : undefined;
    const verdict = outcome?.outcome !== "selected" || !optionId ? "cancelled"
      : kind?.startsWith("allow") ? "allowed"
        : kind?.startsWith("reject") ? "denied" : `answered ${optionId}`;
    return [{ kind: "message", ts: null, role: "system", text: `Permission ${verdict}: ${permission.title}` }];
  }

  function promptEnded(row: JsonObject): TranscriptProjectedEvent[] {
    const events = stream.pushLine(JSON.stringify({ method: "session/prompt_complete" }));
    const closing = events.pop();
    const result = asObject(row.result);
    const error = asObject(row.error);
    if (error) events.push({ kind: "message", ts: null, role: "system", text: `agy error: ${String(error.message ?? "request failed")}` });
    const usage = acpUsageFrom(result?.usage);
    const reported = modelId();
    if (usage) {
      events.push({
        kind: "token_usage",
        ts: null,
        usage,
        scope: "turn",
        ...(reported ? { model: reported } : {}),
        ...(contextWindow !== null ? { modelContextWindow: contextWindow } : {}),
      });
    }
    const stopReason = nonEmptyString(result?.stopReason) ?? (error ? "error" : undefined);
    if (stopReason === "cancelled") events.push({ kind: "interrupt", ts: closing?.ts ?? null, reason: "cancelled" });
    events.push({
      kind: "turn_end",
      ts: closing?.ts ?? null,
      ...(stopReason ? { finishReason: stopReason } : {}),
      ...(stopReason === "cancelled" || error ? { interrupted: true } : {}),
    });
    return events;
  }

  return {
    push(row, line) {
      const method = typeof row.method === "string" ? row.method : undefined;
      if (method === "session/update") {
        const update = asObject(asObject(row.params)?.update);
        if (update?.sessionUpdate === "config_option_update") {
          trackOptions(update.configOptions);
          return [];
        }
        if (update?.sessionUpdate === "usage_update") {
          const size = finiteNumber(update.size);
          if (size !== undefined && size > 0) contextWindow = size;
          return [];
        }
        return stream.pushLine(line);
      }
      if (method === "session/request_permission" && row.id !== undefined && row.id !== null) return permissionRequested(row);
      if (method !== undefined) return stream.pushLine(line);
      if (row.id === undefined || row.id === null) return [];
      const key = JSON.stringify(row.id);
      const permission = permissions.get(key);
      if (permission && ("result" in row || "error" in row) && asObject(row.result)?.outcome !== undefined) {
        permissions.delete(key);
        return permissionAnswered(row, permission);
      }
      if (typeof row.id === "number" && row.id >= AGY_ACP_PROMPT_ID_BASE && ("result" in row || "error" in row)) return promptEnded(row);
      trackResult(asObject(row.result));
      return [];
    },
    flush: () => stream.flush(),
    state: () => ({
      stream: stream.checkpoint().state as GrokCheckpointState,
      model,
      effort,
      contextWindow,
      permissions: [...permissions].map(([key, value]) => [key, { title: value.title, options: value.options.map(([id, kind]) => [id, kind] as [string, string]) }]),
    }),
  };
}
function isUsage(value: unknown): boolean {
  const v = asObject(value);
  return !!v && Object.keys(v).every((key) => USAGE_KEYS.some((allowed) => allowed === key) && checkpointNumber(v[key]));
}
function isFragment(value: unknown): boolean {
  const v = asObject(value);
  return !!v && checkpointRecord(v, { text: checkpointString,
    ...(Object.hasOwn(v, "providerEventId") ? { providerEventId: checkpointString } : {}),
  });
}

export function isAgyCheckpointState(value: unknown): value is AgyCheckpointState {
  const hasAcp = asObject(value) !== undefined && Object.hasOwn(value as object, "acp");
  return checkpointRecord(value, {
    threadId: checkpointNullable(checkpointString),
    sawAssistantText: checkpointBoolean,
    previousResultUsage: checkpointNullable(isUsage),
    previousNumTurns: checkpointNullable(checkpointNumber),
    previousDurationSeconds: checkpointNullable(checkpointNumber),
    assistantFragments: checkpointEntries(isFragment),
    emittedAssistantMessages: isEmittedIdentities,
    emittedToolCalls: isEmittedIdentities,
    emittedToolResults: isEmittedIdentities,
    ...(hasAcp ? { acp: isAgyAcpCheckpointState } : {}),
  });
}
export function createAgyProjector(restored?: AgyCheckpointState): TranscriptProjector {
  let acp: AgyAcpProjection | undefined = restored?.acp ? createAgyAcpProjection(restored.acp) : undefined;
  let threadId: string | undefined = restored?.threadId ?? undefined;
  let sawAssistantText = restored?.sawAssistantText ?? false;
  let previousResultUsage: TranscriptTokenUsage | undefined = restored?.previousResultUsage ?? undefined;
  let previousNumTurns: number | undefined = restored?.previousNumTurns ?? undefined;
  let previousDurationSeconds: number | undefined = restored?.previousDurationSeconds ?? undefined;
  const assistantFragments = new Map<string, AssistantFragment>(restored?.assistantFragments);
  const emittedAssistantMessages = new Set<string>(restored?.emittedAssistantMessages);
  const emittedToolCalls = new Set<string>(restored?.emittedToolCalls);
  const emittedToolResults = new Set<string>(restored?.emittedToolResults);

  function rememberThread(value: unknown): void {
    const next = nonEmptyString(value);
    if (!next) return;
    if (threadId !== undefined && threadId !== next) {
      previousResultUsage = undefined;
      previousNumTurns = undefined;
      previousDurationSeconds = undefined;
      assistantFragments.clear();
      emittedAssistantMessages.clear();
      emittedToolCalls.clear();
      emittedToolResults.clear();
    }
    threadId = next;
  }

  function thread(): { threadId?: string } {
    return threadId ? { threadId } : {};
  }

  function toolCallId(update: JsonObject): string {
    const stepIndex = finiteNumber(update.step_index);
    return `agy:${threadId ?? "unknown"}:${stepIndex ?? "unknown"}`;
  }

  function assistantMessage(fragment: AssistantFragment): TranscriptProjectedEvent {
    return {
      kind: "message",
      ts: null,
      ...thread(),
      role: "assistant",
      text: fragment.text,
      ...(fragment.providerEventId ? { providerEventId: fragment.providerEventId } : {}),
    };
  }

  function projectStep(update: JsonObject): TranscriptProjectedEvent[] {
    rememberThread(update.conversation_id);
    const stepType = nonEmptyString(update.step_type);
    if (stepType === "user_input") return [];

    if (stepType === "agent_response") {
      const stepIndex = finiteNumber(update.step_index);
      const eventId = `agy:${threadId ?? "unknown"}:${stepIndex ?? "unknown"}`;
      const delta = typeof update.text_delta === "string" ? update.text_delta : "";
      if (!emittedAssistantMessages.has(eventId) && delta.length > 0) {
        const held = assistantFragments.get(eventId);
        assistantFragments.set(eventId, {
          text: `${held?.text ?? ""}${delta}`,
          ...(stepIndex !== undefined ? { providerEventId: eventId } : {}),
        });
      }
      const state = nonEmptyString(update.state)?.toUpperCase();
      if (state !== "DONE" || emittedAssistantMessages.has(eventId)) return [];
      const fragment = assistantFragments.get(eventId);
      assistantFragments.delete(eventId);
      if (!fragment || fragment.text.trim().length === 0) return [];
      rememberEmission(emittedAssistantMessages, eventId);
      sawAssistantText = true;
      return [assistantMessage(fragment)];
    }

    if (stepType !== "tool") return [];
    const state = nonEmptyString(update.state)?.toUpperCase();
    const info = asObject(update.tool_info);
    const name = nonEmptyString(update.tool_name) ?? nonEmptyString(info?.name) ?? "tool";
    const callId = toolCallId(update);
    if (state === "ACTIVE" && !emittedToolCalls.has(callId)) {
      rememberEmission(emittedToolCalls, callId);
      return [{
        kind: "tool_call",
        ts: null,
        ...thread(),
        callId,
        name,
        ...(info?.parameters !== undefined ? { input: info.parameters } : {}),
      }];
    }
    if (state && TERMINAL_TOOL_STATES.has(state) && !emittedToolResults.has(callId)) {
      rememberEmission(emittedToolResults, callId);
      const output = printableOutput(info?.output) ?? printableOutput(info?.error);
      return [{
        kind: "tool_result",
        ts: null,
        ...thread(),
        callId,
        name,
        isError: ERROR_TOOL_STATES.has(state),
        ...(output !== undefined ? { output } : {}),
      }];
    }
    return [];
  }

  function projectResult(result: JsonObject): TranscriptProjectedEvent[] {
    rememberThread(result.conversation_id);
    const events: TranscriptProjectedEvent[] = [];
    const response = nonEmptyString(result.response);
    const numTurns = finiteNumber(result.num_turns);
    const turnId = threadId && numTurns !== undefined ? `${threadId}:${numTurns}` : undefined;
    if (response && !sawAssistantText) {
      events.push({ kind: "message", ts: null, ...thread(), role: "assistant", text: response });
    }

    const cumulativeUsage = usageFrom(result.usage);
    if (cumulativeUsage) {
      const canSubtract = previousResultUsage !== undefined
        && previousNumTurns !== undefined
        && numTurns !== undefined
        && numTurns > previousNumTurns;
      events.push({
        kind: "token_usage",
        ts: null,
        ...thread(),
        usage: usageDelta(cumulativeUsage, previousResultUsage, canSubtract),
        scope: "turn",
        ...(turnId ? { providerTurnId: turnId } : {}),
      });
    }

    const status = nonEmptyString(result.status);
    if (status === "ERROR") {
      const reason = nonEmptyString(result.error) ?? response ?? "agy result error";
      events.push({ kind: "interrupt", ts: null, ...thread(), reason });
    }
    const durationSeconds = finiteNumber(result.duration_seconds);
    let turnDurationSeconds: number | undefined;
    if (previousNumTurns === undefined && numTurns === 1) {
      turnDurationSeconds = durationSeconds;
    } else if (
      durationSeconds !== undefined
      && previousDurationSeconds !== undefined
      && previousNumTurns !== undefined
      && numTurns !== undefined
      && numTurns > previousNumTurns
      && durationSeconds >= previousDurationSeconds
    ) {
      turnDurationSeconds = durationSeconds - previousDurationSeconds;
    }
    events.push({
      kind: "turn_end",
      ts: null,
      ...thread(),
      ...(turnId ? { turnId } : {}),
      ...(turnDurationSeconds !== undefined
        ? { durationMs: Math.round(turnDurationSeconds * 1_000_000) / 1_000 }
        : {}),
      ...(status ? { finishReason: status } : {}),
      ...((status === "CANCELED" || status === "ERROR") ? { interrupted: true } : {}),
    });
    if (durationSeconds !== undefined) previousDurationSeconds = durationSeconds;
    previousResultUsage = cumulativeUsage;
    previousNumTurns = numTurns;
    assistantFragments.clear();
    sawAssistantText = false;
    return events;
  }

  return {
    harness: "agy",
    checkpoint() {
      return projectorCheckpoint("agy", {
        threadId: threadId ?? null,
        sawAssistantText: sawAssistantText,
        previousResultUsage: previousResultUsage ?? null,
        previousNumTurns: previousNumTurns ?? null,
        previousDurationSeconds: previousDurationSeconds ?? null,
        assistantFragments: [...assistantFragments],
        emittedAssistantMessages: [...emittedAssistantMessages],
        emittedToolCalls: [...emittedToolCalls],
        emittedToolResults: [...emittedToolResults],
        ...(acp ? { acp: acp.state() } : {}),
      } satisfies AgyCheckpointState);
    },

    pushLine(line: string): TranscriptProjectedEvent[] {
      const row = parseJsonLine(line);
      if (!row) return [];
      if (isAcpRow(row)) {
        acp ??= createAgyAcpProjection();
        return acp.push(row, line);
      }
      const event = nonEmptyString(row.event);
      if (!event) return [];

      if (event === "init") {
        rememberThread(row.conversation_id);
        sawAssistantText = false;
        return [];
      }
      if (event === "user") {
        const message = asObject(row.message);
        const text = textFromContent(message?.content);
        if (!text) return [];
        sawAssistantText = false;
        return [
          { kind: "turn_start", ts: null, ...thread() },
          { kind: "message", ts: null, ...thread(), role: "user", text },
        ];
      }
      if (event === "step_update") {
        const update = asObject(row.step_update);
        return update ? projectStep(update) : [];
      }
      if (event === "result") {
        const result = asObject(row.result);
        return result ? projectResult(result) : [];
      }
      return [{ kind: "unknown", ts: null, ...thread(), nativeType: event }];
    },
    flush(): TranscriptProjectedEvent[] {
      const events: TranscriptProjectedEvent[] = [];
      for (const [eventId, fragment] of assistantFragments) {
        if (fragment.text.trim().length === 0) continue;
        rememberEmission(emittedAssistantMessages, eventId);
        events.push(assistantMessage(fragment));
      }
      assistantFragments.clear();
      if (events.length > 0) sawAssistantText = true;
      return acp ? [...acp.flush(), ...events] : events;
    },
  };
}
// checkpoint-digest:end

export const agyTranscripts: TranscriptFamily = {
  harness: "agy",
  createProjector: () => createAgyProjector(),
  restoreProjector: (state) => isAgyCheckpointState(state) ? createAgyProjector(state) : undefined,
};
