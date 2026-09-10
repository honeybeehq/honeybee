/** Kimi Code ACP. Pure protocol translation; session IDs come only from Kimi. */
import { asObject, bootedToIdle, isAuthNeededMessage, isResourceBlockedMessage, parseJsonLine, successfulTurnClears, type AdapterSignal, type HarnessAdapter } from "./types.ts";
import type { GrokMcpServerStdio } from "./grok.ts";

export type KimiMode = "default" | "plan" | "auto" | "yolo";
export interface KimiAdapterOptions {
  cwd: string;
  model?: string;
  mode?: KimiMode;
  resumeSessionId?: string;
  mcpServers?: readonly GrokMcpServerStdio[];
}

/** ACP configuration replaces the CLI-only model and permission flags. */
export function kimiSpawnPlan(args: readonly string[]): { argv: string[]; model?: string; mode: KimiMode } {
  let model: string | undefined;
  let mode: KimiMode = "default";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--model" || arg === "-m") {
      if (!args[i + 1]) throw new Error("Kimi --model requires a value");
      model = args[++i];
    } else if (arg.startsWith("--model=")) model = arg.slice(8);
    else if (arg === "--yolo" || arg === "-y") mode = "yolo";
    else if (arg === "--auto") mode = "auto";
    else if (arg === "--plan") mode = "plan";
    else if (arg !== "acp") rest.push(arg);
  }
  return { argv: ["acp", ...rest], ...(model ? { model } : {}), mode };
}

const PROMPT_BASE = 1000;
function request(id: string | number, method: string, params: unknown): AdapterSignal[] {
  return [{ kind: "respond", lines: [JSON.stringify({ jsonrpc: "2.0", id, method, params })] }];
}
function failure(message: string, startup: boolean): AdapterSignal[] {
  const flag = isAuthNeededMessage(message) ? "auth_needed"
    : isResourceBlockedMessage(message) ? "resource_blocked" : startup ? "spawn_failed" : undefined;
  return flag ? [{ kind: "flag", flag, action: "set", detail: message.slice(0, 500) }] : [];
}
function configuration(sessionId: string, configId: "model" | "mode", value: string): AdapterSignal[] {
  // Carry the session in our request ID so replay remains stateless, including
  // when a new daemon adopts the host halfway through this handshake.
  return request(`kimi:${configId}:${sessionId}`, "session/set_config_option", { sessionId, configId, value });
}

export function kimiAdapter(opts: KimiAdapterOptions): HarnessAdapter {
  const mode = opts.mode ?? "default";
  return {
    harness: "kimi",
    acceptsMidTurn: false,
    readyAtSpawn: false,
    bootLines: () => [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "Honeybee", version: "2" },
    } })],
    parseLine(line) {
      const row = parseJsonLine(line);
      if (!row) return [];
      if (typeof row.method === "string") {
        if (row.id !== undefined && row.id !== null) {
          if (row.method === "session/request_permission") {
            const options = asObject(row.params)?.options;
            const allowed = (mode === "yolo" || mode === "auto") && Array.isArray(options)
              ? options.map(asObject).find(o => o?.kind === "allow_once" && typeof o.optionId === "string") : undefined;
            const outcome = allowed ? { outcome: "selected", optionId: allowed.optionId } : { outcome: "cancelled" };
            return [{ kind: "respond", lines: [JSON.stringify({ jsonrpc: "2.0", id: row.id, result: { outcome } })] }];
          }
          return [{ kind: "respond", lines: [JSON.stringify({ jsonrpc: "2.0", id: row.id, error: { code: -32601, message: "Unsupported client method" } })] }];
        }
        if (row.method === "session/update") {
          const params = asObject(row.params);
          if (asObject(params?._meta)?.isReplay === true) return [];
          const kind = asObject(params?.update)?.sessionUpdate;
          if (["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(String(kind))) return [{ kind: "turn_started" }];
        }
        return [];
      }
      const prompt = typeof row.id === "number" && row.id >= PROMPT_BASE;
      const startup = row.id === 1 || row.id === 2 || (typeof row.id === "string" && /^kimi:(model|mode):/.test(row.id));
      if (!prompt && !startup) return [];
      if ("error" in row) {
        const message = String(asObject(row.error)?.message ?? "Kimi ACP request failed");
        return [...failure(message, startup), ...(prompt ? [{ kind: "turn_ended" } satisfies AdapterSignal] : [])];
      }
      if (!("result" in row)) return [];
      if (prompt) return [...successfulTurnClears(), { kind: "turn_ended" }];
      if (row.id === 1) {
        if (opts.resumeSessionId) {
          const result = asObject(row.result);
          const caps = asObject(result?.agentCapabilities);
          const sessions = asObject(result?.sessionCapabilities ?? caps?.sessionCapabilities);
          if (caps?.loadSession !== true && (!sessions || !("resume" in sessions))) return failure("Installed Kimi ACP does not advertise session/resume", true);
        }
        return request(2, opts.resumeSessionId ? "session/resume" : "session/new", {
          cwd: opts.cwd, mcpServers: opts.mcpServers ?? [],
          ...(opts.resumeSessionId ? { sessionId: opts.resumeSessionId } : {}),
        });
      }
      if (row.id === 2) {
        const result = asObject(row.result);
        const sessionId = result?.sessionId ?? opts.resumeSessionId;
        if (typeof sessionId !== "string" || !sessionId) return failure("Kimi returned no sessionId", true);
        const options = Array.isArray(result?.configOptions) ? result.configOptions.map(asObject) : [];
        const model = opts.model ?? options.find(o => o?.id === "model")?.currentValue;
        if (typeof model !== "string" || !model || !options.some(o => o?.id === "mode")) return failure("Kimi did not expose model/mode configuration", true);
        return configuration(sessionId, "model", model);
      }
      if (typeof row.id === "string" && row.id.startsWith("kimi:model:")) return configuration(row.id.slice(11), "mode", mode);
      if (typeof row.id === "string" && row.id.startsWith("kimi:mode:")) return bootedToIdle(row.id.slice(10));
      return [];
    },
    encodeMessage(body, ctx) {
      return ctx.sessionId ? JSON.stringify({ jsonrpc: "2.0", id: PROMPT_BASE + ctx.messageId, method: "session/prompt", params: { sessionId: ctx.sessionId, prompt: [{ type: "text", text: body }] } }) : null;
    },
    encodeInterrupt(ctx) {
      return ctx.sessionId ? JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: ctx.sessionId } }) : null;
    },
  };
}
