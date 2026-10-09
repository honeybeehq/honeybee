/**
 * The proof's stand-in for Anthropic: token (refresh + authorization_code),
 * usage and profile endpoints, plus `/control` for the proof script. It runs
 * in its own process so it answers while the proof blocks on CLI calls.
 * Each chain label belongs to one Anthropic account; a login code
 * `code-<label>` starts a new chain with that label.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const owner: Record<string, string> = { kontrol: "acct-kontrol", kontrol2: "acct-kontrol", intruder: "acct-someone-else", crash: "acct-crash", crash2: "acct-crash", margin: "acct-margin", early: "acct-early", due: "acct-due" };
const lifetimeS: Record<string, number> = {};
const refusing = new Set<string>();
const presented: Record<string, number> = {};
const identityOf = (label: string) => ({ account: { uuid: owner[label], email_address: `${label}@example.test` }, organization: { uuid: `org-${owner[label]}` } });
const labelOfToken = (token: string) => token.split(".")[1] ?? "";

const server = createServer((request: IncomingMessage, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const url = request.url ?? "";
    if (url === "/control") {
      if (request.method === "POST") {
        const change = JSON.parse(raw) as { lifetime?: Record<string, number>; refuse?: string };
        Object.assign(lifetimeS, change.lifetime ?? {});
        if (change.refuse) refusing.add(change.refuse);
      }
      return send(200, { presented });
    }
    if (url.startsWith("/api/oauth/usage")) return send(200, { five_hour: { utilization: 7 }, seven_day: { utilization: 19 } });
    if (url.startsWith("/api/oauth/profile")) {
      const label = labelOfToken(String(request.headers.authorization ?? "").replace(/^Bearer /, ""));
      return owner[label] ? send(200, { ...identityOf(label), organization: { ...identityOf(label).organization, organization_type: "claude_max" } }) : send(401, {});
    }
    const body = JSON.parse(raw) as { grant_type: string; refresh_token?: string; code?: string };
    if (body.grant_type === "authorization_code") {
      const label = String(body.code).replace(/^code-/, "");
      return send(200, { access_token: `stub-access.${label}.1`, refresh_token: `stub-refresh.${label}.1`, expires_in: lifetimeS[label] ?? 8 * 3600,
        refresh_token_expires_in: 28 * 24 * 3600, scope: "user:inference user:profile", ...identityOf(label) });
    }
    const [, label = "", serial] = String(body.refresh_token).split(".");
    presented[label] = (presented[label] ?? 0) + 1;
    if (refusing.has(label)) return send(400, { error: "invalid_grant", error_description: "Refresh token not found or invalid" });
    send(200, { access_token: `stub-access.${label}.${Number(serial) + 1}`, refresh_token: `stub-refresh.${label}.${Number(serial) + 1}`, expires_in: lifetimeS[label] ?? 8 * 3600,
      refresh_token_expires_in: label === "due" ? 2 * 24 * 3600 : 28 * 24 * 3600, ...identityOf(label) });
  });
});
server.listen(0, "127.0.0.1", () => { process.stdout.write(`${(server.address() as AddressInfo).port}\n`); });
