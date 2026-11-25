import { performance } from "node:perf_hooks";

export const LOOP_SLICE_MS = 20;

export type Steps<T> = Generator<void, T, void>;

export function runSteps<T>(steps: Steps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

export class LoopPacer {
  private readonly sliceMs: number;
  private sliceStartedAt = performance.now();
  private yieldCount = 0;
  private longestSliceMs = 0;

  constructor(sliceMs = LOOP_SLICE_MS) {
    this.sliceMs = sliceMs;
  }

  get yields(): number {
    return this.yieldCount;
  }

  get longestSlice(): number {
    return Math.round(this.longestSliceMs);
  }

  async pace(): Promise<void> {
    const sliceMs = performance.now() - this.sliceStartedAt;
    if (sliceMs < this.sliceMs) return;
    this.longestSliceMs = Math.max(this.longestSliceMs, sliceMs);
    await new Promise<void>(resolve => setImmediate(resolve));
    this.yieldCount += 1;
    this.sliceStartedAt = performance.now();
  }

  async run<T>(steps: Steps<T>): Promise<T> {
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      await this.pace();
    }
  }
}
