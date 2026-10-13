/**
 * Provider limits responses → the store's limits snapshot (spec 08 "Limits").
 * PURE response parsing, ported from the old src/limits/claude.ts (usage
 * endpoint mapping incl. the Fable-scoped weekly entry) and
 * src/limits/codex.ts (assignCodexWindows: duration-classified windows win
 * over positional guesses). The transport (OAuth GET, `codex app-server`
 * JSON-RPC) is injected by the daemon and never runs here.
 */
import type { PutAccountLimitsInput } from "./store.ts";
import type { AccountLimitsRow } from "./types.ts";

/** GET api.anthropic.com/api/oauth/usage — the shape Claude Code's /usage panel reads. */
export type ClaudeUsageResponse = {
  five_hour?: { utilization?: number | null; resets_at?: string | null } | null;
  seven_day?: { utilization?: number | null; resets_at?: string | null } | null;
  /**
   * Modern limits array. Model-scoped weekly entries carry the plan's
   * included usage per model (e.g. Fable on Claude 5 plans); the unscoped
   * session/weekly entries duplicate five_hour/seven_day.
   */
  limits?: Array<{
    kind?: string | null;
    percent?: number | null;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null } | null;
  } | null> | null;
};

/** `codex app-server` → `account/rateLimits/read` result.rateLimits. */
export type CodexLiveWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
export type CodexLiveRateLimits = {
  primary?: CodexLiveWindow | null;
  secondary?: CodexLiveWindow | null;
  planType?: string | null;
  rateLimitResetCredits?: PutAccountLimitsInput["rateLimitResetCredits"];
};

type Window = NonNullable<PutAccountLimitsInput["weekly"]>;

const CLAUDE_FIVE_HOUR_MINUTES = 300;
const CLAUDE_WEEKLY_MINUTES = 10_080;

function isoToMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Claude: five_hour → fiveHour (300 min), seven_day → weekly (10080 min), and
 * the `weekly_scoped` limits[] entry whose model display name is Fable →
 * fableWeekly. No windows at all = unreadable ("usage endpoint returned no
 * windows"), exactly as before.
 */
export function parseClaudeUsage(usage: ClaudeUsageResponse, plan?: string | null): PutAccountLimitsInput {
  const out: PutAccountLimitsInput = { readable: true, ...(plan ? { plan } : {}) };
  if (typeof usage.five_hour?.utilization === "number") {
    out.fiveHour = { usedPercent: usage.five_hour.utilization, windowMinutes: CLAUDE_FIVE_HOUR_MINUTES, resetsAt: isoToMs(usage.five_hour.resets_at) };
  }
  if (typeof usage.seven_day?.utilization === "number") {
    out.weekly = { usedPercent: usage.seven_day.utilization, windowMinutes: CLAUDE_WEEKLY_MINUTES, resetsAt: isoToMs(usage.seven_day.resets_at) };
  }
  // Fable included usage rides the limits[] array as a model-scoped weekly
  // entry (the legacy seven_day_<model> fields stay null on Claude 5 plans).
  const fable = usage.limits?.find(
    (entry) => entry?.kind === "weekly_scoped" && /^fable\b/i.test(entry.scope?.model?.display_name ?? ""),
  );
  if (fable && typeof fable.percent === "number") {
    out.fableWeekly = { usedPercent: fable.percent, windowMinutes: CLAUDE_WEEKLY_MINUTES, resetsAt: isoToMs(fable.resets_at) };
  }
  if (!out.fiveHour && !out.weekly) {
    out.readable = false;
    out.error = "usage endpoint returned no windows";
  }
  return out;
}

const CODEX_FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const CODEX_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

type CodexWindowSlot = "fiveHour" | "weekly";

function codexWindowSlot(windowMinutes: number | undefined): CodexWindowSlot | null {
  if (windowMinutes === CODEX_FIVE_HOUR_WINDOW_MINUTES) return "fiveHour";
  if (windowMinutes === CODEX_WEEKLY_WINDOW_MINUTES) return "weekly";
  return null;
}

function liveWindow(window: CodexLiveWindow): Window {
  return {
    usedPercent: window.usedPercent!,
    resetsAt: window.resetsAt ? window.resetsAt * 1000 : null,
    windowMinutes: typeof window.windowDurationMins === "number" ? window.windowDurationMins : null,
  };
}

/**
 * Codex normally calls the 5h window `primary` and the weekly window
 * `secondary`, but it promotes the weekly window to `primary` when the 5h
 * limit is disabled. Prefer the explicit duration so that temporary provider
 * changes do not shift a weekly value into the 5h column. Positional fallback
 * keeps older responses without duration metadata compatible.
 */
export function parseCodexRateLimits(limits: CodexLiveRateLimits): PutAccountLimitsInput {
  const out: PutAccountLimitsInput = {
    readable: true,
    ...(limits.planType ? { plan: limits.planType } : {}),
    rateLimitResetCredits: limits.rateLimitResetCredits ?? null,
  };
  const candidates: Array<{ usage: Window; duration: number | undefined; fallback: CodexWindowSlot }> = [];
  const add = (window: CodexLiveWindow | null | undefined, fallback: CodexWindowSlot) => {
    // An omitted utilization is uncertainty, not evidence of zero use. Do
    // not synthesize headroom from a partial provider response.
    if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return;
    candidates.push({ usage: liveWindow(window), duration: window.windowDurationMins, fallback });
  };
  add(limits.primary, "fiveHour");
  add(limits.secondary, "weekly");
  // Duration-classified windows win over positional guesses.
  for (const candidate of candidates) {
    const slot = codexWindowSlot(candidate.duration);
    if (slot && !out[slot]) out[slot] = candidate.usage;
  }
  for (const candidate of candidates) {
    if (codexWindowSlot(candidate.duration)) continue;
    const alternate: CodexWindowSlot = candidate.fallback === "fiveHour" ? "weekly" : "fiveHour";
    const slot = !out[candidate.fallback] ? candidate.fallback : !out[alternate] ? alternate : null;
    if (slot) out[slot] = candidate.usage;
  }
  if (!out.fiveHour && !out.weekly) {
    out.readable = false;
    out.error = "app-server returned no rate-limit windows";
  }
  return out;
}

/**
 * Muse MSP `SubscriptionUsage` (the `usage/changed` params and the
 * `usage/read` result's `usage`): what the host last observed on its own
 * provider responses. Muse has no active usage probe.
 */
export type MuseSubscriptionUsage = {
  observedAtMs?: number;
  tier?: string;
  window?: { usedPercent?: number; resetsAtMs?: number; windowDurationMins?: number } | null;
  weekly?: { usedPercent?: number; resetsAtMs?: number } | null;
};

/** Muse MSP `turn/completed.error.quota` (QuotaDetail). */
export type MuseQuotaDetail = { limitKind?: string; resetsAtMs?: number };

const finitePercent = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const positiveMs = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/**
 * Muse: the current window (the provider's 5-hour-class block) → fiveHour
 * with its reported duration, the rolling weekly block → weekly. The tier is
 * an opaque subscription id, not a plan name, so it sets no plan. The snapshot
 * is dated by the host's observedAtMs — an observation, not a live read. Null when the payload
 * carries no observation time or no window (nothing to record).
 */
export function parseMuseUsage(usage: MuseSubscriptionUsage): PutAccountLimitsInput | null {
  const observedAt = positiveMs(usage.observedAtMs);
  if (observedAt === null) return null;
  const out: PutAccountLimitsInput = {
    readable: true,
    fetchedAt: observedAt,
  };
  const window = usage.window;
  if (window && finitePercent(window.usedPercent)) {
    out.fiveHour = {
      usedPercent: window.usedPercent,
      resetsAt: positiveMs(window.resetsAtMs),
      windowMinutes: positiveMs(window.windowDurationMins),
    };
  }
  const weekly = usage.weekly;
  if (weekly && finitePercent(weekly.usedPercent)) {
    out.weekly = { usedPercent: weekly.usedPercent, resetsAt: positiveMs(weekly.resetsAtMs), windowMinutes: null };
  }
  return out.fiveHour || out.weekly ? out : null;
}

/** A quota's reset names its window when it matches that window's observed reset within this skew. */
const MUSE_QUOTA_RESET_MATCH_MS = 60_000;

/**
 * Muse: a quota-exhausted turn says only which reset it waits for. Mark the
 * previously observed window with that reset as used up (at least 100%),
 * dated observedAt. Null when no observed window has that reset: the
 * exhaustion still reaches the account through the resource_blocked flag,
 * and inventing a window would be a guess.
 */
export function museQuotaLimits(previous: AccountLimitsRow | null, quota: MuseQuotaDetail, observedAt: number): PutAccountLimitsInput | null {
  const resetsAt = positiveMs(quota.resetsAtMs);
  if (!previous?.readable || resetsAt === null) return null;
  const matches = (reset: number | null) => reset !== null && Math.abs(reset - resetsAt) <= MUSE_QUOTA_RESET_MATCH_MS;
  const window = (pct: number | null, reset: number | null, minutes: number | null, exhausted: boolean) =>
    pct === null ? null : { usedPercent: exhausted ? Math.max(pct, 100) : pct, resetsAt: reset, windowMinutes: minutes };
  const fiveHourExhausted = matches(previous.fiveHourResetsAt);
  const weeklyExhausted = matches(previous.weeklyResetsAt);
  if (!fiveHourExhausted && !weeklyExhausted) return null;
  return {
    readable: true,
    fetchedAt: observedAt,
    fiveHour: window(previous.fiveHourPct, previous.fiveHourResetsAt, previous.fiveHourMinutes, fiveHourExhausted),
    weekly: window(previous.weeklyPct, previous.weeklyResetsAt, previous.weeklyMinutes, weeklyExhausted),
  };
}

/**
 * The claude `.credentials.json` / Keychain payload → the fields the limits
 * fetch needs (access token, expiry, plan). Null when the shape is not a
 * claudeAiOauth credential.
 */
export function parseClaudeCredentials(raw: string | null): { accessToken: string; expiresAt: number; subscriptionType?: string; refreshToken?: string; refreshTokenExpiresAt?: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || typeof oauth.expiresAt !== "number") return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: oauth.expiresAt,
      ...(typeof oauth.subscriptionType === "string" ? { subscriptionType: oauth.subscriptionType } : {}),
      ...(typeof oauth.refreshToken === "string" ? { refreshToken: oauth.refreshToken } : {}),
      ...(typeof oauth.refreshTokenExpiresAt === "number" && Number.isSafeInteger(oauth.refreshTokenExpiresAt) ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The Muse `auth.json` meta provider entry → its non-secret shape: a stored
 * API key, or an OAuth login with its expiry (epoch ms; Muse writes a u64
 * whose unit is unconfirmed, so seconds are normalized like Grok's) and
 * whether a refresh token exists; or `keychain` when the file only points at
 * the OS keychain (macOS `storage:"keychain"`: a login exists, but none of it
 * is in the file). Null when no usable meta credential is stored. Token
 * values are never returned.
 */
export function parseMuseCredentials(raw: string | null): { mechanism: "api_key" } | { mechanism: "oauth"; expiresAt: number | null; refreshable: boolean } | { mechanism: "keychain" } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
    const meta = parsed.providers?.meta as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
    if (typeof meta.api_key === "string" && meta.api_key.length > 0) return { mechanism: "api_key" };
    if (meta.storage === "keychain") return { mechanism: "keychain" };
    if (meta.mechanism !== "oauth" || typeof meta.access_token !== "string" || meta.access_token.length === 0) return null;
    const rawExpiry = meta.expires_at;
    const expiresAt = typeof rawExpiry === "number" && Number.isFinite(rawExpiry) && rawExpiry > 0
      ? (rawExpiry > 1e11 ? rawExpiry : rawExpiry * 1000)
      : null;
    return { mechanism: "oauth", expiresAt, refreshable: typeof meta.refresh_token === "string" && meta.refresh_token.length > 0 };
  } catch {
    return null;
  }
}

/**
 * A REAL provider auth failure, as opposed to a missing credential or a
 * transport error (old src/limits/dispatch.ts isAuthFailureLimitsError):
 * these mean "this credential does not authenticate" — the account goes
 * auth_needed and drops out of auto selection until positive evidence lands.
 */
export function isAuthFailureLimitsError(message: string): boolean {
  const m = message.toLowerCase();
  return /\bhttp 401\b/.test(m)
    || m.includes("revoked")
    || m.includes("unauthorized")
    || m.includes("invalid_grant")
    || m.includes("refresh failed");
}
