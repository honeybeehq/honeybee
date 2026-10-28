export const AUTH_NEEDED_DETAIL = "Authentication is required; sign in or refresh account credentials.";

export function safeFlagDetail(flag: string, action: string, detail: string): string {
  if (flag === "auth_needed" && action === "set") return AUTH_NEEDED_DETAIL;
  return detail
    .replace(/\bBearer\s+[^\s,"']+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){0,2}/g, "[REDACTED]")
    .replace(/((?:refresh[_-]?token|access[_-]?token|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, "$1[REDACTED]");
}
