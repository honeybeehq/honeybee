import { quietReply } from "../../core/src/quiet.ts";
import { createTranscriptProjector } from "./transcripts.ts";
import type { TranscriptProjector } from "./transcript-projection.ts";

export class TurnQuiet {
  private readonly projector: TranscriptProjector;
  private sessionId: string | null = null;
  private finalText: string | undefined;

  constructor(harness: string) {
    this.projector = createTranscriptProjector(harness);
  }

  pushLine(line: string, sessionId: string | null): void {
    this.sessionId = sessionId;
    this.accept(this.projector.pushLine(line));
  }

  private accept(events: ReturnType<TranscriptProjector["pushLine"]>): void {
    for (const event of events) {
      if (event.threadId && this.sessionId && event.threadId !== this.sessionId) continue;
      if (event.kind === "turn_start") this.finalText = undefined;
      if (event.kind === "message" && event.role === "assistant") this.finalText = event.text;
    }
  }

  end(): boolean | undefined {
    this.accept(this.projector.flush());
    const quiet = this.finalText === undefined ? undefined : quietReply(this.finalText).quiet;
    this.finalText = undefined;
    return quiet;
  }
}
