import { asObject, parseJsonLine } from "../../adapters/src/types.ts";
import { quietReply } from "../../core/src/quiet.ts";
import { createTranscriptProjector } from "./transcripts.ts";
import type { TranscriptProjector } from "./transcript-projection.ts";

export class TurnQuiet {
  private readonly harness: string;
  private projector: TranscriptProjector | null = null;
  private sessionId: string | null = null;
  private finalText: string | undefined;
  private terminal = false;
  private failed = false;

  constructor(harness: string) {
    this.harness = harness;
    this.reset();
  }

  reset(): void {
    this.finalText = undefined;
    this.terminal = false;
    this.failed = false;
    try {
      this.projector = createTranscriptProjector(this.harness);
    } catch {
      this.projector = null;
    }
  }

  pushLine(line: string, sessionId: string | null): void {
    this.sessionId = sessionId;
    const row = parseJsonLine(line);
    if (row?.isSidechain === true || row?.parent_tool_use_id != null) return;
    const params = asObject(row?.params);
    const scope = params?.threadId ?? params?.sessionId ?? row?.session_id ?? row?.sessionId;
    if (sessionId && typeof scope === "string" && scope !== sessionId) return;
    if (this.harness === "grok" || this.harness === "kimi") {
      const promptResponse = row?.method === undefined && typeof row?.id === "number" && row.id >= 1000;
      const update = asObject(params?.update);
      const completion = typeof row?.method === "string" && (
        row.method.endsWith("/prompt_complete") || row.method.endsWith("/prompt_completed")
        || update?.sessionUpdate === "turn_completed" || update?.type === "turn_completed"
      );
      const outcome = promptResponse ? asObject(row?.result) : update ?? params;
      if (promptResponse && (row?.error != null || outcome?.stopReason !== "end_turn")) this.invalidate();
      if (completion && (outcome?.error != null || outcome?.stopReason !== undefined && outcome.stopReason !== "end_turn")) this.invalidate();
    }
    if (row?.type === "result" && row.is_error === true) this.invalidate();
    const response = asObject(row?.response);
    if (row?.type === "control_response" && typeof response?.request_id === "string" && response.request_id.startsWith("hive-interrupt-")) this.invalidate();
    try {
      this.accept(this.projector?.pushLine(line) ?? []);
    } catch {
      this.projector = null;
      this.finalText = undefined;
      this.terminal = false;
    }
  }

  private accept(events: ReturnType<TranscriptProjector["pushLine"]>): void {
    for (const event of events) {
      if (event.threadId && this.sessionId && event.threadId !== this.sessionId) continue;
      if (event.kind === "turn_start") {
        this.finalText = undefined;
        this.terminal = false;
        this.failed = false;
      }
      if (event.kind === "message" && event.role === "assistant") this.finalText = event.text;
      if (event.kind === "interrupt") this.invalidate();
      if (event.kind === "turn_end") {
        this.terminal = true;
        if (event.interrupted || /^(failed|error|interrupted|cancelled|canceled)$/i.test(event.finishReason ?? "")) this.invalidate();
      }
    }
  }

  invalidate(): void {
    this.failed = true;
  }

  end(opts: { requireTerminal?: boolean; finalText?: string } = {}): boolean | undefined {
    try {
      this.accept(this.projector?.flush() ?? []);
    } catch {
      this.projector = null;
      this.finalText = undefined;
      this.terminal = false;
    }
    const text = this.failed ? undefined : opts.finalText ?? (opts.requireTerminal && !this.terminal ? undefined : this.finalText);
    const quiet = text === undefined ? undefined : quietReply(text).quiet;
    this.finalText = undefined;
    this.terminal = false;
    this.failed = false;
    return quiet;
  }
}
