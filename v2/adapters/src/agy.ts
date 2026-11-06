/**
 * Antigravity CLI over ACP (`agy acp`, agy 1.5.1 or newer). Newline-delimited
 * JSON-RPC 2.0 on stdio; the adapter is pure protocol translation. Sign-in is
 * agy's own: the adapter never reads a credential, and Honeybee holds no agy
 * account (core `machineSignInOnly`).
 *
 *   we write : initialize {protocolVersion:1, clientCapabilities, clientInfo:{name:"Honeybee",version:"2"}}
 *   server   : initialize result                       → respond:
 *   we write :   session/new {cwd, mcpServers}  (session/resume {sessionId, cwd, mcpServers})
 *   server   : auth-required error                     → with GEMINI_API_KEY in the spawn env:
 *   we write :   authenticate {methodId:"gemini-api-key"}, then the session request once more
 *                (without the key: `auth_needed`; the user signs in with agy itself)
 *   server   : session result {sessionId}              → respond, each only when requested:
 *   we write :   session/set_config_option model        (`--model`, a family or a concrete id; a refusal
 *                                                        retries as session/set_model)
 *   we write :   session/set_config_option thought_level (`--effort`)
 *   we write :   session/set_config_option mode          (`--mode`; a refusal retries as session/set_mode)
 *   server   : last configuration result               → booted (idle)
 *   we write : session/prompt {sessionId, prompt:[{type:"text",text}]}
 *   server   : session/update chunks and tool calls    → turn_started
 *   server   : session/prompt result {stopReason}      → turn_ended
 *   we write : session/cancel {sessionId}              (interrupt; the prompt then ends `cancelled`)
 *   server   : session/request_permission              → allow once under
 *                `--dangerously-skip-permissions`, else decline
 *
 * Request ids carry the session id, so every signal derives from the input
 * line alone and a daemon that adopts the host mid-handshake replays the same
 * decisions. Verified against agy 1.5.2 on 2026-11-06 (SMOKE.md): the `model`
 * option takes families and concrete ids alike, the prompt response carries
 * `usage`, and agy sends config_option_update, available_commands_update and
 * session_info_update outside prompts, none of which opens a turn.
 */
import {
  asObject,
  bootedToIdle,
  isAuthNeededMessage,
  isResourceBlockedMessage,
  parseJsonLine,
  successfulTurnClears,
  toNumber as finiteNumber,
  type AdapterSignal,
  type HarnessAdapter,
} from "./types.ts";
import { createGrokProjector, isGrokCheckpointState, type GrokCheckpointState, type GrokMcpServerStdio } from "./grok.ts";
import {
  projectorCheckpoint,
  type TranscriptFamily, type TranscriptProjectedEvent, type TranscriptProjector, type TranscriptTokenUsage,
} from "./transcript.ts";

export const AGY_MODES = ["default", "accept-edits", "plan"] as const;
export type AgyMode = (typeof AGY_MODES)[number];
export const AGY_EFFORTS = ["low", "medium", "high"] as const;
export type AgyEffort = (typeof AGY_EFFORTS)[number];

/**
 * `agy acp` exists from 1.5.0. 1.5.1 is the floor: it is the first release
 * that stops sending session/update after the session/prompt reply, and a late
 * update would reopen a turn that nothing closes.
 */
export const AGY_MIN_VERSION = "1.5.1";

export interface AgyAdapterOptions {
  cwd: string;
  /** A model family (`gemini-4-argon`) or a concrete model id (`gemini-4-argon-high`). */
  model?: string;
  /** The `thought_level` configuration option. */
  effort?: AgyEffort;
  mode?: AgyMode;
  /** The spawn carries `--dangerously-skip-permissions`: answer permission requests with allow-once. */
  skipPermissions?: boolean;
  /** The spawn env carries GEMINI_API_KEY: an auth-required session request authenticates with `gemini-api-key`. */
  apiKeyAuth?: boolean;
  resumeSessionId?: string;
  /** Live operator gateways, passed as this session's MCP servers. */
  mcpServers?: readonly GrokMcpServerStdio[];
}

/** Why the installed agy cannot run `agy acp`, from the first line of `agy --version`; null when it can or the version is unreadable. */
export function agyVersionRefusal(versionLine: string | null): string | null {
  const found = versionLine?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!found) return null;
  const installed = found.slice(1, 4).map(Number);
  const floor = AGY_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (installed[i]! > floor[i]!) return null;
    if (installed[i]! < floor[i]!) {
      return `agy ${found[0]} is too old for Honeybee: it runs agy over ACP (\`agy acp\`), which needs agy ${AGY_MIN_VERSION} or newer. Update agy on this computer.`;
    }
  }
  return null;
}

const INITIALIZE_ID = 1;
const SESSION_ID = 2;
const SESSION_AFTER_AUTH_ID = 3;
const AUTHENTICATE_ID = "agy:auth";
const PROMPT_BASE = 1000;
const ACP_AUTH_REQUIRED = -32000;
const METHOD_NOT_FOUND = -32601;
const SIGN_IN_HINT = "Sign in with agy on this computer (run `agy`, or `agy acp --login` on a headless host), or set GEMINI_API_KEY.";

type Step = "model" | "set_model" | "effort" | "mode" | "set_mode";
const STEP_ID = /^agy:(model|set_model|effort|mode|set_mode):(.+)$/s;

function line(message: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", ...message });
}

function respond(...lines: string[]): AdapterSignal[] {
  return [{ kind: "respond", lines }];
}

/** agy reports provider failures as a generic message with the cause in `data`; classify on both. */
function errorText(error: Record<string, unknown> | undefined, fallback: string): string {
  const message = typeof error?.message === "string" && error.message.length > 0 ? error.message : fallback;
  const data = error?.data;
  if (data === undefined || data === null) return message;
  const detail = typeof data === "string" ? data : JSON.stringify(data);
  return detail.length > 0 && detail !== "{}" ? `${message}: ${detail}` : message;
}

function isAuthRequired(error: Record<string, unknown> | undefined, text: string): boolean {
  return error?.code === ACP_AUTH_REQUIRED || isAuthNeededMessage(text);
}

function failure(error: Record<string, unknown> | undefined, fallback: string, startup: boolean): AdapterSignal[] {
  const text = errorText(error, fallback);
  if (isAuthRequired(error, text)) {
    return [{ kind: "flag", flag: "auth_needed", action: "set", detail: `${text.slice(0, 300)}. ${SIGN_IN_HINT}` }];
  }
  const flag = isResourceBlockedMessage(text) ? "resource_blocked" : startup ? "spawn_failed" : undefined;
  return flag ? [{ kind: "flag", flag, action: "set", detail: text.slice(0, 500) }] : [];
}

/** Decline unless the spawn skips permissions; then pick the provider's own allow-once option. */
function permissionOutcome(params: unknown, allow: boolean): Record<string, unknown> {
  const raw = asObject(params)?.options;
  const options = (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    const option = asObject(entry);
    return typeof option?.optionId === "string" && typeof option.kind === "string" ? [{ optionId: option.optionId, kind: option.kind }] : [];
  });
  const pick = (...kinds: string[]) => kinds.map((kind) => options.find((option) => option.kind === kind)).find((option) => option !== undefined);
  const selected = allow ? pick("allow_once", "allow_always") : pick("reject_once", "reject_always");
  return selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" };
}

export function agyAdapter(opts: AgyAdapterOptions): HarnessAdapter {
  const sessionRequest = (id: number): string => line({
    id,
    method: opts.resumeSessionId ? "session/resume" : "session/new",
    params: {
      cwd: opts.cwd,
      mcpServers: (opts.mcpServers ?? []).map((server) => ({ ...server, args: [...server.args], env: server.env.map((entry) => ({ ...entry })) })),
      ...(opts.resumeSessionId ? { sessionId: opts.resumeSessionId } : {}),
    },
  });

  function configure(step: Step, sessionId: string): AdapterSignal[] {
    const id = `agy:${step}:${sessionId}`;
    switch (step) {
      case "model": return respond(line({ id, method: "session/set_config_option", params: { sessionId, configId: "model", value: opts.model } }));
      case "set_model": return respond(line({ id, method: "session/set_model", params: { sessionId, modelId: opts.model } }));
      case "effort": return respond(line({ id, method: "session/set_config_option", params: { sessionId, configId: "thought_level", value: opts.effort } }));
      case "mode": return respond(line({ id, method: "session/set_config_option", params: { sessionId, configId: "mode", value: opts.mode } }));
      case "set_mode": return respond(line({ id, method: "session/set_mode", params: { sessionId, modeId: opts.mode } }));
    }
  }

  /** The configuration request after `done`, or readiness when nothing requested remains. */
  function next(done: "session" | "model" | "effort" | "mode", sessionId: string): AdapterSignal[] {
    if (done === "session" && opts.model) return configure("model", sessionId);
    if ((done === "session" || done === "model") && opts.effort) return configure("effort", sessionId);
    if (done !== "mode" && opts.mode) return configure("mode", sessionId);
    return bootedToIdle(sessionId);
  }

  function responseSignals(row: Record<string, unknown>): AdapterSignal[] {
    const error = "error" in row ? asObject(row.error) ?? {} : undefined;
    if (!error && !("result" in row)) return [];

    if (row.id === INITIALIZE_ID) {
      if (error) return failure(error, "agy initialize failed", true);
      if (opts.resumeSessionId) {
        const result = asObject(row.result);
        const capabilities = asObject(result?.agentCapabilities);
        const sessions = capabilities?.sessionCapabilities ?? result?.sessionCapabilities;
        const resumes = Array.isArray(sessions) ? sessions.includes("resume") : "resume" in (asObject(sessions) ?? {});
        if (!resumes) return failure(undefined, "The installed agy does not advertise session/resume; update agy", true);
      }
      return respond(sessionRequest(SESSION_ID));
    }

    if (row.id === SESSION_ID || row.id === SESSION_AFTER_AUTH_ID) {
      if (error) {
        const retry = row.id === SESSION_ID && opts.apiKeyAuth === true && isAuthRequired(error, errorText(error, ""));
        if (retry) return respond(line({ id: AUTHENTICATE_ID, method: "authenticate", params: { methodId: "gemini-api-key" } }));
        return failure(error, "agy session request failed", true);
      }
      const sessionId = asObject(row.result)?.sessionId ?? opts.resumeSessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) return failure(undefined, "agy returned no sessionId", true);
      return next("session", sessionId);
    }

    if (row.id === AUTHENTICATE_ID) {
      if (error) {
        return [{ kind: "flag", flag: "auth_needed", action: "set", detail: `agy refused GEMINI_API_KEY: ${errorText(error, "authenticate failed").slice(0, 300)}. ${SIGN_IN_HINT}` }];
      }
      return respond(sessionRequest(SESSION_AFTER_AUTH_ID));
    }

    const step = typeof row.id === "string" ? STEP_ID.exec(row.id) : null;
    if (step) {
      const kind = step[1] as Step;
      const sessionId = step[2]!;
      if (error) {
        // A second route for an agy whose option refuses the value (1.5.2 accepts families and concrete ids).
        if (kind === "model") return configure("set_model", sessionId);
        if (kind === "mode") return configure("set_mode", sessionId);
        const what = kind === "set_model" ? `model ${opts.model}` : kind === "effort" ? `effort ${opts.effort}` : `mode ${opts.mode}`;
        const flags = failure(error, "configuration refused", true);
        return flags.map((signal) => signal.kind === "flag" && signal.flag === "spawn_failed"
          ? { ...signal, detail: `agy refused ${what}: ${signal.detail}`.slice(0, 500) }
          : signal);
      }
      return next(kind === "set_model" ? "model" : kind === "set_mode" ? "mode" : kind, sessionId);
    }

    if (typeof row.id === "number" && row.id >= PROMPT_BASE) {
      if (error) return [...failure(error, "agy session/prompt failed", false), { kind: "turn_ended" }];
      // A cancelled prompt proves nothing about the provider; every other stop reason was served.
      const served = asObject(row.result)?.stopReason !== "cancelled";
      return [...(served ? successfulTurnClears() : []), { kind: "turn_ended" }];
    }
    return [];
  }

  return {
    harness: "agy",
    acceptsMidTurn: false,
    readyAtSpawn: false,
    bootLines: () => [line({ id: INITIALIZE_ID, method: "initialize", params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "Honeybee", version: "2" },
    } })],
    parseLine(raw) {
      const row = parseJsonLine(raw);
      if (!row) return [];
      if (typeof row.method !== "string") return responseSignals(row);
      if (row.id !== undefined && row.id !== null) {
        if (row.method === "session/request_permission") {
          return respond(line({ id: row.id, result: { outcome: permissionOutcome(row.params, opts.skipPermissions === true) } }));
        }
        return respond(line({ id: row.id, error: { code: METHOD_NOT_FOUND, message: `unsupported client method: ${row.method}` } }));
      }
      if (row.method !== "session/update") return [];
      const params = asObject(row.params);
      if (asObject(params?._meta)?.isReplay === true) return [];
      const kind = asObject(params?.update)?.sessionUpdate;
      return kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "tool_call" || kind === "tool_call_update"
        ? [{ kind: "turn_started" }]
        : [];
    },
    encodeMessage(body, ctx) {
      if (!ctx.sessionId) return null;
      return line({ id: PROMPT_BASE + ctx.messageId, method: "session/prompt", params: { sessionId: ctx.sessionId, prompt: [{ type: "text", text: body }] } });
    },
    encodeInterrupt(ctx) {
      return ctx.sessionId ? line({ method: "session/cancel", params: { sessionId: ctx.sessionId } }) : null;
    },
  };
}

/** agy titles an MCP call `Run mcp_<server>_<tool>`; the tool is the name. */
const MCP_TITLE = /^Run (mcp_[A-Za-z0-9_.-]+)$/;

/**
 * The same row with the tool call named by its tool; null when the row needs
 * no change. agy 1.5.2 puts the tool's identifier in `name` beside a display
 * `title` (`name: "mcp_smoke_smoke_echo"`, `title: "Run mcp_smoke_smoke_echo"`);
 * a row without `name` falls back to the identifier inside an MCP title.
 */
function withToolName(row: Record<string, unknown>): string | null {
  if (row.method !== "session/update") return null;
  const params = asObject(row.params);
  const update = asObject(params?.update);
  if (!update || (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")) return null;
  const tool = typeof update.name === "string" && update.name.trim().length > 0
    ? update.name
    : typeof update.title === "string" ? MCP_TITLE.exec(update.title)?.[1] : undefined;
  return tool && tool !== update.title ? JSON.stringify({ ...row, params: { ...params, update: { ...update, title: tool } } }) : null;
}

/** ACP prompt usage. Gemini counts cached reads inside the input; the projection's `input` is uncached. */
function promptUsage(value: unknown): TranscriptTokenUsage | undefined {
  const usage = asObject(value);
  if (!usage) return undefined;
  const inputInclusive = finiteNumber(usage.inputTokens);
  const cacheRead = finiteNumber(usage.cachedReadTokens);
  const input = inputInclusive !== undefined && cacheRead !== undefined ? Math.max(0, inputInclusive - cacheRead) : inputInclusive;
  const output = finiteNumber(usage.outputTokens);
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

// checkpoint-digest:start
/**
 * agy speaks the ACP chunks and tool calls the Grok projector already folds;
 * its turns close on the session/prompt response, which also carries the stop
 * reason and the turn's usage.
 */
export function createAgyProjector(restored?: GrokCheckpointState): TranscriptProjector {
  const acp = createGrokProjector(restored);
  return {
    harness: "agy",
    checkpoint: () => projectorCheckpoint("agy", acp.checkpoint().state),
    pushLine(raw) {
      const row = parseJsonLine(raw);
      if (!row) return [];
      const promptResponse = row.method === undefined && typeof row.id === "number" && row.id >= PROMPT_BASE && ("result" in row || "error" in row);
      if (!promptResponse) return acp.pushLine(withToolName(row) ?? raw);
      const events = acp.pushLine(JSON.stringify({ method: "session/prompt_complete" }));
      const end = events.pop();
      if (end?.kind !== "turn_end") return end ? [...events, end] : events;
      const closing: TranscriptProjectedEvent[] = [];
      let finish: { finishReason?: string; interrupted?: boolean };
      if ("error" in row) {
        closing.push({ kind: "interrupt", ts: null, reason: errorText(asObject(row.error), "agy session/prompt failed") });
        finish = { finishReason: "error", interrupted: true };
      } else {
        const result = asObject(row.result);
        const usage = promptUsage(result?.usage);
        if (usage) closing.push({ kind: "token_usage", ts: null, usage, scope: "turn" });
        const stopReason = typeof result?.stopReason === "string" ? result.stopReason : undefined;
        finish = { ...(stopReason ? { finishReason: stopReason } : {}), ...(stopReason === "cancelled" ? { interrupted: true } : {}) };
      }
      return [...events, ...closing, { ...end, ...finish }];
    },
    flush: () => acp.flush(),
  };
}
// checkpoint-digest:end

export const agyTranscripts: TranscriptFamily = {
  harness: "agy",
  createProjector: () => createAgyProjector(),
  restoreProjector: (state) => isGrokCheckpointState(state) ? createAgyProjector(state) : undefined,
};
