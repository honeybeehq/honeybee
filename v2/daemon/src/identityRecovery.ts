export interface UnresolvedRuntime {beeId: string; generation: number; since: number}
export class IdentityRecovery {
  private readonly rows = new Map<string, UnresolvedRuntime>();
  private lastAttempt = -Infinity;
  private cursor = 0;
  retain(row: UnresolvedRuntime): void { this.rows.set(`${row.beeId}:${row.generation}`, row); }
  has(beeId: string, generation: number): boolean { return this.rows.has(`${beeId}:${generation}`); }
  diagnostic(beeId: string, generation: number | null, now: number): {message: "identity unresolved"; warning: boolean} | undefined {
    const row = generation === null ? undefined : this.rows.get(`${beeId}:${generation}`);
    return row ? {message: "identity unresolved", warning: now - row.since >= 600000} : undefined;
  }
  entries(): UnresolvedRuntime[] { return [...this.rows.values()]; }
  counts(now: number): {count: number; overdue: number} { return {count: this.rows.size, overdue: this.entries().filter(row => now - row.since >= 600000).length}; }
  retry(now: number, recover: (row: UnresolvedRuntime) => boolean): void {
    if (now - this.lastAttempt < 1000) return;
    this.lastAttempt = now;
    const rows = this.entries();
    for (let n = 0; n < Math.min(16, rows.length); n++) {
      const row = rows[(this.cursor + n) % rows.length]!;
      try { if (recover(row)) this.rows.delete(`${row.beeId}:${row.generation}`); } catch {}
    }
    this.cursor = rows.length ? (this.cursor + 16) % rows.length : 0;
  }
}
