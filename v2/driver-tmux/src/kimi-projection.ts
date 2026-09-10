/** Kimi and Grok share ACP chunks/tools; Kimi closes turns with RPC results. */
import { createGrokProjector } from "./grok-projection.ts";
import { projectorCheckpoint, type TranscriptProjector } from "./transcript-projection.ts";

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* A partial or non-JSON line has no projected content. */ }
  return undefined;
}

export function createKimiProjector(restored?: Parameters<typeof createGrokProjector>[0]): TranscriptProjector {
  const acp = createGrokProjector(restored);
  return {
    harness: "kimi",
    checkpoint: () => projectorCheckpoint("kimi", acp.checkpoint().state),
    pushLine(line) {
      const row = parseJsonLine(line);
      if (row && row.method === undefined && typeof row.id === "number" && row.id >= 1000 && ("result" in row || "error" in row)) {
        const events = acp.pushLine(JSON.stringify({ method: "session/prompt_complete" }));
        const error = row.error;
        if (error && typeof error === "object" && "message" in error) events.unshift({ kind: "message", ts: null, role: "assistant", text: `Kimi error: ${String(error.message)}` });
        return events;
      }
      return acp.pushLine(line);
    },
    flush: () => acp.flush(),
  };
}
