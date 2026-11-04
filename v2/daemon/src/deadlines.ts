interface Entry {
  at: number;
  key: string;
  version: number;
}

export class DeadlineHeap {
  private readonly heap: Entry[] = [];
  private readonly current = new Map<string, Entry>();

  get size(): number {
    return this.current.size;
  }

  at(key: string): number | null {
    return this.current.get(key)?.at ?? null;
  }

  schedule(key: string, at: number): void {
    const existing = this.current.get(key);
    if (existing && existing.at <= at) return;
    const entry = { at, key, version: (existing?.version ?? 0) + 1 };
    this.current.set(key, entry);
    this.heap.push(entry);
    this.siftUp(this.heap.length - 1);
  }

  cancel(key: string): void {
    this.current.delete(key);
  }

  popDue(now: number): string[] {
    const due: string[] = [];
    while (this.heap.length > 0) {
      const top = this.heap[0]!;
      if (top.at > now) break;
      this.popTop();
      const live = this.current.get(top.key);
      if (live !== top) continue;
      this.current.delete(top.key);
      due.push(top.key);
    }
    return due;
  }

  private popTop(): void {
    const last = this.heap.pop()!;
    if (this.heap.length === 0) return;
    this.heap[0] = last;
    this.siftDown(0);
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent]!.at <= this.heap[i]!.at) return;
      [this.heap[parent], this.heap[i]] = [this.heap[i]!, this.heap[parent]!];
      i = parent;
    }
  }

  private siftDown(index: number): void {
    let i = index;
    for (;;) {
      const left = 2 * i + 1, right = left + 1;
      let smallest = i;
      if (left < this.heap.length && this.heap[left]!.at < this.heap[smallest]!.at) smallest = left;
      if (right < this.heap.length && this.heap[right]!.at < this.heap[smallest]!.at) smallest = right;
      if (smallest === i) return;
      [this.heap[smallest], this.heap[i]] = [this.heap[i]!, this.heap[smallest]!];
      i = smallest;
    }
  }
}
