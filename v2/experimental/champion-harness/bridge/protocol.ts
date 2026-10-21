export const BRIDGE_VERSION = 1;
export type InputFrame = { v: 1; type: "mail"; messageId: number; body: string } | { v: 1; type: "interrupt" };
export type OutputFrame =
  | { v: 1; type: "loaded_config"; tools: string[]; servers: string[]; settingSources: string[] }
  | { v: 1; type: "ready"; writerEpoch: number }
  | { v: 1; type: "accepted"; messageId: number; writerEpoch: number }
  | { v: 1; type: "turn_started"; messageId: number; turnId: string; at: number }
  | { v: 1; type: "turn_finished"; messageId: number; outcome: "success" | "auth_error" | "resource_error" | "interrupted" | "error"; served: boolean; at: number }
  | { v: 1; type: "boundary"; boundary: "auth" | "resource"; messageId: number }
  | { v: 1; type: "usage"; messageId: number; usage: Record<string, unknown> }
  | { v: 1; type: "timing"; messageId: number; event: "query_start" | "first_token" | "first_visible"; at: number }
  | { v: 1; type: "human_output"; id: string; messageId: number; kind: "tell" | "react"; origin: "human" | "surface_gate"; content: string; at: number }
  | { v: 1; type: "fatal"; code: "writer_conflict" | "invalid_input" | "state_error" | "sdk_unavailable" | "launch_refused" };

export function parseInput(line: string): InputFrame {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object") throw new Error("invalid_input");
  const r = value as Record<string, unknown>;
  if (r.v !== 1) throw new Error("invalid_input");
  if (r.type === "interrupt") return { v: 1, type: "interrupt" };
  if (r.type === "mail" && Number.isSafeInteger(r.messageId) && Number(r.messageId) > 0 && typeof r.body === "string") {
    return { v: 1, type: "mail", messageId: Number(r.messageId), body: r.body };
  }
  throw new Error("invalid_input");
}
