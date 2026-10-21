import { BridgeState } from "./state.ts";
import type { OutputFrame, InputFrame } from "./protocol.ts";
import type { SdkQuery } from "./sdk.ts";

export class BridgeEngine {
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private readonly state: BridgeState;
  private readonly sdk: SdkQuery;
  private readonly identity: string;
  private readonly emit: (frame: OutputFrame) => void;
  constructor(state: BridgeState, sdk: SdkQuery, identity: string, emit: (frame: OutputFrame) => void) {
    this.state = state; this.sdk = sdk; this.identity = identity; this.emit = emit;
  }
  start(): void { this.emit({ v: 1, type: "ready", writerEpoch: this.state.epoch }); this.schedule(); }
  input(frame: InputFrame): void {
    if (this.stopped) throw new Error("bridge_stopped");
    if (frame.type === "interrupt") { this.controller?.abort(); return; }
    this.state.accept(frame);
    this.emit({ v: 1, type: "accepted", messageId: frame.messageId, writerEpoch: this.state.epoch });
    this.schedule();
  }
  private schedule(): void {
    if (this.running || this.stopped) return;
    this.running = Promise.resolve().then(() => this.drain()).catch(() => { this.stopped = true; this.emit({ v: 1, type: "fatal", code: "state_error" }); }).finally(() => { this.running = null; });
  }
  async settled(): Promise<void> { await this.running; }
  async stop(): Promise<void> { this.stopped = true; this.controller?.abort(); await this.running; }
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const mail = this.state.next();
      if (!mail) return;
      const epoch = this.state.epoch;
      const { messageId } = mail;
      const turnId = `${epoch}:${messageId}`;
      const context = this.state.context();
      this.controller = new AbortController();
      let served = false, resultSuccess = false, failed = false;
      let boundary: "auth" | "resource" | null = null;
      let firstToken = false, firstVisible = false;
      this.emit({ v: 1, type: "turn_started", messageId, turnId, at: Date.now() });
      this.emit({ v: 1, type: "timing", messageId, event: "query_start", at: Date.now() });
      try {
        const systemPrompt = [this.identity, "Tools: no tool effects are enabled in this adapter slice.", `Memory snapshot:\n${context.memory}`, `Running summary:\n${context.summary}`].join("\n\n");
        for await (const event of this.sdk.run({ prompt: `New mail (${messageId}):\n${mail.body}`, systemPrompt, ...(context.sessionId ? { sessionId: context.sessionId } : {}), signal: this.controller })) {
          this.state.record(epoch, messageId, event);
          switch (event.type) {
            case "session": this.state.session(epoch, messageId, event.sessionId); break;
            case "loaded": this.emit({ v: 1, type: "loaded_config", tools: event.tools, servers: event.servers, settingSources: [] }); break;
            case "private": served ||= event.served; break;
            case "failure": failed = true; break;
            case "human_output": {
              const at = Date.now();
              this.emit({ v: 1, type: "human_output", id: event.id, messageId, kind: event.kind, origin: event.origin, content: event.content, at });
              if (!firstVisible) { firstVisible = true; this.emit({ v: 1, type: "timing", messageId, event: "first_visible", at }); }
              break;
            }
            case "token":
              if (!firstToken) { firstToken = true; this.emit({ v: 1, type: "timing", messageId, event: "first_token", at: Date.now() }); }
              break;
            case "boundary": boundary = event.boundary; this.emit({ v: 1, type: "boundary", messageId, boundary }); break;
            case "result": failed ||= !event.success; resultSuccess = event.success; this.emit({ v: 1, type: "usage", messageId, usage: event.usage }); break;
          }
        }
      } catch { failed = true; }
      const interrupted = this.controller.signal.aborted;
      const success = resultSuccess && served && !boundary && !failed && !interrupted;
      this.state.finish(epoch, messageId, success);
      this.emit({ v: 1, type: "turn_finished", messageId, served: success, outcome: boundary === "auth" ? "auth_error" : boundary === "resource" ? "resource_error" : interrupted ? "interrupted" : success ? "success" : "error", at: Date.now() });
      this.controller = null;
      if (!success) return;
    }
  }
}
