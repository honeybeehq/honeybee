import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isAuthNeededMessage, isResourceBlockedMessage } from "../../../adapters/src/types.ts";
import type { RuntimePolicy } from "./policy.ts";

export type QueryEvent =
  | { type: "session"; sessionId: string }
  | { type: "token" }
  | { type: "failure" }
  | { type: "human_output"; id: string; kind: "tell" | "react"; origin: "human" | "surface_gate"; content: string }
  | { type: "private"; value: unknown; served: boolean }
  | { type: "loaded"; tools: string[]; servers: string[] }
  | { type: "boundary"; boundary: "auth" | "resource" }
  | { type: "result"; success: boolean; usage: Record<string, unknown> };
export interface QueryRequest { prompt: string; systemPrompt: string; sessionId?: string; signal: AbortController }
export interface SdkQuery { run(request: QueryRequest): AsyncIterable<QueryEvent> }

export function realSdk(policy: RuntimePolicy, env: Record<string, string>): SdkQuery {
  return {
    async *run(request) {
      const stream = query({ prompt: request.prompt, options: {
        systemPrompt: request.systemPrompt,
        ...(request.sessionId ? { resume: request.sessionId } : {}),
        env,
        abortController: request.signal,
        pathToClaudeCodeExecutable: policy.cliPath,
        tools: [],
        allowedTools: [],
        mcpServers: policy.mcpServers,
        strictMcpConfig: true,
        settingSources: [],
        includePartialMessages: true,
        persistSession: true,
        canUseTool: async () => ({ behavior: "deny", message: "Tool execution is disabled in T2" }),
      } });
      const abort = () => stream.close();
      request.signal.signal.addEventListener("abort", abort, { once: true });
      try {
        for await (const event of stream) {
          if (event.type === "system" && event.subtype === "init" && (event.tools.some(tool => !/^mcp__apiary__[a-zA-Z0-9_]+$/.test(tool)) || event.mcp_servers.some(server => server.name !== "apiary"))) throw new Error("loaded_config_refused");
          yield* normalize(event);
        }
      } finally { request.signal.signal.removeEventListener("abort", abort); stream.close(); }
    },
  };
}
function* normalize(event: SDKMessage): Iterable<QueryEvent> {
  if (event.type === "system" && event.subtype === "init") {
    yield { type: "session", sessionId: event.session_id };
    yield { type: "loaded", tools: event.tools, servers: event.mcp_servers.map(server => server.name) };
  } else if (event.type === "assistant") {
    const text = event.message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (event.error === "authentication_failed" || event.error === "oauth_org_not_allowed" || isAuthNeededMessage(text)) yield { type: "boundary", boundary: "auth" };
    else if (event.error === "rate_limit" || event.error === "overloaded" || event.error === "billing_error" || isResourceBlockedMessage(text)) yield { type: "boundary", boundary: "resource" };
    if (event.error) yield { type: "failure" };
    yield { type: "private", value: event, served: !event.error && event.message.content.length > 0 };
  } else if (event.type === "stream_event") {
    if (event.event.type === "content_block_delta" && (event.event.delta.type === "text_delta" || event.event.delta.type === "thinking_delta")) yield { type: "token" };
  } else if (event.type === "result") {
    if (event.subtype !== "success") {
      const detail = event.errors.join("\n");
      if (isAuthNeededMessage(detail)) yield { type: "boundary", boundary: "auth" };
      else if (isResourceBlockedMessage(detail)) yield { type: "boundary", boundary: "resource" };
    }
    yield { type: "result", success: event.subtype === "success" && !event.is_error, usage: { ...event.usage } };
  }
}
