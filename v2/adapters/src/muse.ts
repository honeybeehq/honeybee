/**
 * Muse Code harness adapter — normalizes `muse serve` (Muse Session Protocol
 * v1: newline-delimited JSON-RPC 2.0 on stdio). Wire facts captured from
 * muse 1.4.7 (schema sha256:6de32db0…7df9) on the offline echo provider:
 *
 *   we write : initialize {clientInfo:{name:"honeybee"}, capabilities:
 *                {requestedCapabilities:["sessionMcp"], userInputDialogs:false}}
 *   server   : initialize result                          → respond:
 *   we write :   initialized + session/start {commandId, workspaceRoot,
 *                approvalMode, modelId?, config:{mcpServers}}
 *                (or session/resume {sessionId, commandId, excludeItems, config})
 *   server   : session/start|resume result {session:{sessionId}} → booted (idle)
 *                (resume with a model first sends session/setModel)
 *   we write : turn/start {sessionId, commandId, input, ifBusy, reasoningEffort?}
 *   server   : turn/start result {disposition}             → delivery_confirmed
 *   server   : turn/started {sessionId, turnId}            → turn_started
 *   server   : turn/completed {sessionId, terminal, error?} → turn_ended
 *   we write : turn/interrupt {sessionId, commandId, turnId?}
 *   server   : usage/changed {tier, observedAtMs, window, weekly} → usage_observed
 *                (the host's last-observed subscription usage; also a
 *                turn/completed error.quota {limitKind, resetsAtMs})
 *
 * Every command carries a UUIDv7 `commandId`, and the host deduplicates by
 * it: a session/start retried with the same id returns the SAME session, and
 * a turn/start reusing an id with other input is `command_id_conflict`. Turn
 * ids derive from the mailbox message id so a redelivery is the same command;
 * setup and interrupt commands are minted fresh per runtime.
 *
 * Mid-turn mail is `ifBusy: "steer"` (folds into the running turn; on an
 * idle session it starts one). Session MCP servers need the `sessionMcp`
 * capability, else session/start fails `-32010 capabilityRequired`.
 */
import { randomBytes } from "node:crypto";
import {
  asObject,
  bootedToIdle,
  isAuthNeededMessage,
  isResourceBlockedMessage,
  parseJsonLine,
  successfulTurnClears,
  type AdapterSignal,
  type EncodeContext,
  type HarnessAdapter,
  type InterruptContext,
} from "./types.ts";
import type { GrokMcpServerStdio } from "./grok.ts";

export type MuseApprovalMode = "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched";
export const MUSE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type MuseEffort = (typeof MUSE_EFFORTS)[number];

export interface MuseAdapterOptions {
  cwd: string;
  model?: string;
  effort?: MuseEffort;
  /** Wire approval mode; Honeybee has no approval bridge, so the default is allowAll. */
  approvalMode?: MuseApprovalMode;
  /** Live operator gateways, passed as this session's native MCP servers. */
  mcpServers?: readonly GrokMcpServerStdio[];
  resumeSessionId?: string;
  /** session/start|resume idempotency handle; minted per runtime when absent. */
  setupCommandId?: string;
}

const INITIALIZE_ID = 1;
const SESSION_SETUP_ID = 2;
const SET_MODEL_PREFIX = "muse:model:";
const INTERRUPT_ID = "muse:interrupt";
const TURN_REQUEST_ID_BASE = 1000;
const METHOD_NOT_FOUND = -32601;
const PROGRESS_ITEM_KINDS = new Set(["agentMessage", "reasoning", "toolCall", "webSearch", "subagent", "workflow"]);

function formatUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A fresh RFC 9562 UUIDv7 (MSP rejects other command id versions). */
export function museFreshCommandId(nowMs: number = Date.now()): string {
  const rand = randomBytes(10).toString("hex");
  const variant = ((parseInt(rand[3]!, 16) & 0x3) | 0x8).toString(16);
  return formatUuid(`${nowMs.toString(16).padStart(12, "0").slice(-12)}7${rand.slice(0, 3)}${variant}${rand.slice(4, 19)}`);
}

/** The turn/start command id for a mailbox message: stable across redelivery. */
export function museMessageCommandId(messageId: number): string {
  const hex = messageId.toString(16).padStart(18, "0");
  return formatUuid(`0000000000007${hex.slice(0, 3)}8${hex.slice(3)}`);
}

export function museSessionMcpServers(servers: readonly GrokMcpServerStdio[]): Record<string, unknown> {
  return Object.fromEntries(servers.map((server) => [server.name, {
    transport: "stdio",
    command: server.command,
    args: [...server.args],
    env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
    mode: "optional",
  }]));
}

function line(message: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", ...message });
}

function failureSignals(error: Record<string, unknown> | undefined, fallback: string, startup: boolean): AdapterSignal[] {
  const message = String(error?.message ?? fallback);
  const detail = message.slice(0, 500);
  const quota = asObject(error?.quota);
  if (quota) {
    const resetsAt = typeof quota.resetsAtMs === "number" && quota.resetsAtMs > 0 ? quota.resetsAtMs : undefined;
    return [{ kind: "flag", flag: "resource_blocked", action: "set", detail: `muse quota exhausted (${String(quota.limitKind ?? "unknown")}): ${message}`.slice(0, 500), ...(resetsAt ? { resetsAt } : {}) }];
  }
  if (error?.kind === "authRequired" || isAuthNeededMessage(message)) return [{ kind: "flag", flag: "auth_needed", action: "set", detail }];
  if (isResourceBlockedMessage(message)) return [{ kind: "flag", flag: "resource_blocked", action: "set", detail }];
  return startup ? [{ kind: "flag", flag: "spawn_failed", action: "set", detail }] : [];
}

export function museAdapter(opts: MuseAdapterOptions): HarnessAdapter {
  const setupCommandId = opts.setupCommandId ?? museFreshCommandId();
  const setModelCommandId = museFreshCommandId();
  const config = { mcpServers: museSessionMcpServers(opts.mcpServers ?? []) };
  const setupLine = opts.resumeSessionId
    ? line({ id: SESSION_SETUP_ID, method: "session/resume", params: { sessionId: opts.resumeSessionId, commandId: setupCommandId, excludeItems: true, config } })
    : line({ id: SESSION_SETUP_ID, method: "session/start", params: {
      commandId: setupCommandId,
      workspaceRoot: opts.cwd,
      approvalMode: opts.approvalMode ?? "allowAll",
      ...(opts.model ? { modelId: opts.model } : {}),
      config,
    } });

  function responseSignals(msg: Record<string, unknown>): AdapterSignal[] {
    const error = asObject(msg.error);
    if (msg.id === INITIALIZE_ID) {
      if (error) return failureSignals(error, "muse initialize failed", true);
      return [{ kind: "respond", lines: [line({ method: "initialized" }), setupLine] }];
    }
    if (msg.id === SESSION_SETUP_ID) {
      if (error) return failureSignals(error, "muse session setup failed", true);
      const session = asObject(asObject(msg.result)?.session);
      const sessionId = typeof session?.sessionId === "string" && session.sessionId ? session.sessionId : undefined;
      if (!sessionId) return failureSignals(undefined, "muse session setup returned no sessionId", true);
      if (opts.resumeSessionId && opts.model && session?.modelId !== opts.model) {
        return [{ kind: "respond", lines: [line({ id: `${SET_MODEL_PREFIX}${sessionId}`, method: "session/setModel", params: {
          sessionId, commandId: setModelCommandId, model: { modelId: opts.model },
        } })] }];
      }
      return bootedToIdle(sessionId);
    }
    if (typeof msg.id === "string" && msg.id.startsWith(SET_MODEL_PREFIX)) {
      if (error) return failureSignals(error, "muse session/setModel failed", true);
      return bootedToIdle(msg.id.slice(SET_MODEL_PREFIX.length));
    }
    if (typeof msg.id === "number" && msg.id >= TURN_REQUEST_ID_BASE) {
      const messageId = msg.id - TURN_REQUEST_ID_BASE;
      if (!Number.isSafeInteger(messageId)) return [];
      if (error) return [{ kind: "delivery_refused", messageId }, ...failureSignals(error, "muse turn/start failed", false)];
      if ("result" in msg) return [{ kind: "delivery_confirmed", messageId }];
    }
    return [];
  }

  function notificationSignals(method: string, params: Record<string, unknown>): AdapterSignal[] {
    const threadId = typeof params.sessionId === "string" && params.sessionId ? params.sessionId : undefined;
    const scope = threadId ? { threadId } : {};
    switch (method) {
      case "turn/started": {
        const turnId = typeof params.turnId === "string" && params.turnId ? params.turnId : undefined;
        return [{ kind: "turn_started", ...(turnId ? { turnId } : {}), ...scope }];
      }
      case "turn/completed": {
        const error = asObject(params.error);
        const quota = params.terminal === "failed" ? asObject(error?.quota) : undefined;
        const evidence = params.terminal === "completed"
          ? successfulTurnClears()
          : params.terminal === "failed"
            ? failureSignals(error, String(params.reason ?? "muse turn failed"), false)
            : [];
        return [...evidence, ...(quota ? [{ kind: "usage_observed" as const, quota }] : []), { kind: "turn_ended", ...scope }];
      }
      case "usage/changed":
        return [{ kind: "usage_observed", usage: params }];
      case "item/started": {
        const kind = asObject(params.item)?.kind;
        return typeof kind === "string" && PROGRESS_ITEM_KINDS.has(kind) ? [{ kind: "turn_progress" }] : [];
      }
      case "session/tokenUsage":
        return [{ kind: "turn_progress" }];
      default:
        return [];
    }
  }

  return {
    harness: "muse",
    acceptsMidTurn: true,
    confirmsDelivery: true,
    reportsTurnProgress: true,
    readyAtSpawn: false,
    bootLines: () => [line({ id: INITIALIZE_ID, method: "initialize", params: {
      clientInfo: { name: "honeybee", title: "Honeybee", version: "2" },
      capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: false },
    } })],
    parseLine(raw) {
      const msg = parseJsonLine(raw);
      if (!msg) return [];
      if (typeof msg.method !== "string") return responseSignals(msg);
      if (msg.id !== undefined && msg.id !== null) {
        return [{ kind: "respond", lines: [line({ id: msg.id, error: { code: METHOD_NOT_FOUND, message: `unsupported server request: ${msg.method}` } })] }];
      }
      return notificationSignals(msg.method, asObject(msg.params) ?? {});
    },
    encodeMessage(body: string, ctx: EncodeContext): string | null {
      if (!ctx.sessionId) return null;
      return line({ id: TURN_REQUEST_ID_BASE + ctx.messageId, method: "turn/start", params: {
        sessionId: ctx.sessionId,
        commandId: museMessageCommandId(ctx.messageId),
        input: [{ type: "text", text: body }],
        ifBusy: ctx.turnActive ? "steer" : "queue",
        ...(opts.effort ? { reasoningEffort: opts.effort } : {}),
      } });
    },
    encodeInterrupt(ctx: InterruptContext): string | null {
      if (!ctx.sessionId) return null;
      return line({ id: INTERRUPT_ID, method: "turn/interrupt", params: {
        sessionId: ctx.sessionId,
        commandId: museFreshCommandId(),
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
      } });
    },
  };
}
