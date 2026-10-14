import { withoutRpcCaller } from "../../core/src/rpcAuditContext.ts";

export class LocalRpcRefusals {
  private readonly buckets = new Map<string, {reason: string; uid: number | null; count: number; firstAtMs: number; lastAtMs: number; firstPid: number | null; lastPid: number | null}>();
  private readonly audit: (kind: string, data: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;
  constructor(audit: (kind: string, data: Record<string, unknown>) => void, now = Date.now) {
    this.audit = audit; this.now = now;
    this.timer = withoutRpcCaller(() => setInterval(() => this.flush(), 60_000));
    this.timer.unref();
  }
  record(reason: string, uid: number | null, pid: number | null): void {
    let key = `${reason}:${uid}`;
    if (!this.buckets.has(key) && this.buckets.size >= 128) key = "overflow";
    const previous = this.buckets.get(key);
    const at = this.now();
    if (previous) { previous.count++; previous.lastAtMs = at; previous.lastPid = pid; }
    else this.buckets.set(key, {reason: key === "overflow" ? "overflow" : reason, uid: key === "overflow" ? null : uid, count: 1, firstAtMs: at, lastAtMs: at, firstPid: pid, lastPid: pid});
  }
  flush(): void {
    withoutRpcCaller(() => { for (const bucket of this.buckets.values()) this.audit("rpc.local_refused", {...bucket}); });
    this.buckets.clear();
  }
  close(): void { clearInterval(this.timer); this.flush(); }
}
