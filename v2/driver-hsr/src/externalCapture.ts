export const EXTERNAL_CAPTURE_CAP = 16 * 1024 * 1024;
export const EXTERNAL_DRAIN_PASSES = 32;
export class ExternalCapture {
  private readonly streams = new Map<string, {bytes: number; truncated: boolean}>();
  private readonly cap: number;
  constructor(cap = EXTERNAL_CAPTURE_CAP) {
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("Invalid capture cap");
    this.cap = cap;
  }
  take(stream: string, available: number): number {
    const state = this.streams.get(stream) ?? {bytes: 0, truncated: false};
    const accepted = Math.min(available, this.cap - state.bytes);
    state.bytes += accepted;
    state.truncated ||= accepted < available;
    this.streams.set(stream, state);
    return accepted;
  }
  snapshot() { return {schema: "honeybee.external.capture.v1", capPerStream: this.cap, streams: Object.fromEntries(this.streams)}; }
  get truncated(): boolean { return [...this.streams.values()].some(stream => stream.truncated); }
}
