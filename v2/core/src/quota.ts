export type QuotaBoundary = {
  harness: "claude" | "codex";
  window: "five_hour" | "weekly" | "other";
  resetsAt: number | null;
  providerCategory: "rate_limit_event" | "synthetic_limit" | "errored_result_limit" | "rateLimitReachedType" | "usageLimitExceeded";
};

export type QuotaObservedEvent = {
  eventId: string;
  beeId: string;
  generation: number;
  quota: QuotaBoundary;
  turn: { messageIds: number[]; progress: "none" | "some" | "unknown" };
};
