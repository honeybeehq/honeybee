import { bootedToIdle, parseJsonLine, successfulTurnClears, type AdapterSignal, type HarnessAdapter } from "./types.ts";

export const claudeSdkAdapter: HarnessAdapter = {
  harness: "claude-sdk",
  acceptsMidTurn: true,
  confirmsDelivery: true,
  readyAtSpawn: false,
  bootLines: () => [],
  encodeMessage: (body, ctx) => JSON.stringify({ v: 1, type: "mail", messageId: ctx.messageId, body }),
  encodeInterrupt: () => JSON.stringify({ v: 1, type: "interrupt" }),
  parseLine(line): AdapterSignal[] {
    const frame = parseJsonLine(line);
    if (frame?.v !== 1) return [];
    switch (frame.type) {
      case "ready": return Number.isSafeInteger(frame.writerEpoch) && Number(frame.writerEpoch) > 0 ? bootedToIdle() : [];
      case "accepted": return Number.isSafeInteger(frame.messageId) && Number(frame.messageId) > 0
        ? [{ kind: "delivery_confirmed", messageId: Number(frame.messageId) }] : [];
      case "turn_started": return typeof frame.turnId === "string" ? [{ kind: "turn_started", turnId: frame.turnId }] : [];
      case "turn_finished": return ["success", "auth_error", "resource_error", "interrupted", "error"].includes(String(frame.outcome)) && typeof frame.served === "boolean" ? [
        ...(frame.outcome === "success" && frame.served === true ? successfulTurnClears() : []),
        { kind: "turn_ended" },
      ] : [];
      case "boundary": return frame.boundary === "auth" || frame.boundary === "resource"
        ? [{ kind: "flag", flag: frame.boundary === "auth" ? "auth_needed" : "resource_blocked", action: "set", detail: `SDK ${frame.boundary} boundary` }] : [];
      case "usage": return frame.usage && typeof frame.usage === "object" && !Array.isArray(frame.usage)
        ? [{ kind: "usage_observed", usage: frame.usage as Record<string, unknown> }] : [];
      case "fatal": return [{ kind: "flag", flag: "spawn_failed", action: "set", detail: `Champion bridge ${String(frame.code)}` }];
      default: return [];
    }
  },
};
