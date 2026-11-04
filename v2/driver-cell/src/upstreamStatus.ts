export interface UpstreamFetchObservation {
  status: "fetched" | "fresh" | "unmirrored" | "failed";
  code?: string;
  error?: string | null;
  parked?: boolean;
  nextAttemptAt?: number;
}

export interface UpstreamFetchStatus {
  enabled: boolean;
  checked: boolean;
  failures: Array<{ originRepo: string; code: string; error: string; parked: boolean; nextAttemptAt: number | null }>;
}

export class UpstreamFetchMonitor {
  private checked = false;
  private readonly failures = new Map<string, UpstreamFetchStatus["failures"][number]>();

  observe(originRepo: string, observation: UpstreamFetchObservation): void {
    this.checked = true;
    if (observation.status !== "failed") { this.failures.delete(originRepo); return; }
    const code = observation.code ?? "fetch_failed";
    this.failures.set(originRepo, { originRepo, code, error: (observation.error ?? code).slice(0, 1024), parked: observation.parked ?? code !== "fetch_failed", nextAttemptAt: observation.nextAttemptAt ?? null });
  }

  snapshot(enabled: boolean): UpstreamFetchStatus {
    return { enabled, checked: this.checked, failures: [...this.failures.values()].map(failure => ({ ...failure })) };
  }
}

export function upstreamFetchLine(status: UpstreamFetchStatus): string {
  if (!status.enabled) return `upstream fetch: off${status.failures.length ? ` · ${status.failures.length} held` : ""}`;
  if (!status.checked) return "upstream fetch: awaiting background check";
  if (!status.failures.length) return "upstream fetch: no failures reported";
  return `upstream fetch: ${status.failures.length} held · ${status.failures.map(failure => `${failure.originRepo}: ${failure.code}${failure.parked ? " (parked; repair policy or credentials)" : ` (retry ${failure.nextAttemptAt == null ? "pending" : new Date(failure.nextAttemptAt).toISOString()})`}`).join("; ")}`;
}
