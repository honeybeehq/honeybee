import { quietReply } from "../../core/src/quiet.ts";
import { createTranscriptProjector } from "./transcripts.ts";
import type { TranscriptProjector } from "./transcript-projection.ts";

export class TurnQuiet {
  private readonly harness: string;
  private projector: TranscriptProjector | null = null;
  private sessionId: string | null = null;
  private finalText: string | undefined;
  private terminal = false;

  constructor(harness: string) {
    this.harness = harness;
    this.reset();
  }

  reset(): void {
    this.finalText = undefined;
    this.terminal = false;
    try {
      this.projector = createTranscriptProjector(this.harness);
    } catch {
      this.projector = null;
    }
  }

  pushLine(line: string, sessionId: string | null): void {
    this.sessionId = sessionId;
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
      }
      if (event.kind === "message" && event.role === "assistant") this.finalText = event.text;
      if (event.kind === "turn_end") this.terminal = true;
    }
  }

  end(opts: { requireTerminal?: boolean; finalText?: string } = {}): boolean | undefined {
    try {
      this.accept(this.projector?.flush() ?? []);
    } catch {
      this.projector = null;
      this.finalText = undefined;
      this.terminal = false;
    }
    const text = opts.finalText ?? (opts.requireTerminal && !this.terminal ? undefined : this.finalText);
    const quiet = text === undefined ? undefined : quietReply(text).quiet;
    this.finalText = undefined;
    this.terminal = false;
    return quiet;
  }
}
