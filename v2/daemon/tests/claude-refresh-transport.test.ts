/**
 * The Claude OAuth refresh transport against a local stub token endpoint:
 * every provider answer maps onto one typed outcome, and no outcome carries
 * token content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { defaultClaudeRefreshTransport, describeRefreshFailure, oauthErrorOf, sanitizeProviderText } from "../src/claudeRefreshTransport.ts";
import { defaultLoginTransports } from "../src/login/transports.ts";

const REFRESH = "FIXTURE-REFRESH-TOKEN-0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-10-09T00:00:00Z");

async function withTokenEndpoint<T>(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void, run: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => handler(request, response, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/oauth/token`;
  const previous = process.env.HIVE_CLAUDE_OAUTH_TOKEN_URL;
  process.env.HIVE_CLAUDE_OAUTH_TOKEN_URL = url;
  try {
    return await run(url);
  } finally {
    if (previous === undefined) delete process.env.HIVE_CLAUDE_OAUTH_TOKEN_URL;
    else process.env.HIVE_CLAUDE_OAUTH_TOKEN_URL = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

test("refresh transport: success carries the access expiry and the login's own expiry", async () => {
  await withTokenEndpoint((_request, response, body) => {
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ["client_id", "grant_type", "refresh_token"]);
    json(response, 200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 28_800, refresh_token_expires_in: 2_419_200, scope: "user:inference user:profile" });
  }, async () => {
    assert.deepEqual(await defaultClaudeRefreshTransport(2_000, () => NOW)(REFRESH), { kind: "success", token: {
      accessToken: "new-access", refreshToken: "new-refresh", expiresAt: NOW + 28_800_000, refreshTokenExpiresAt: NOW + 2_419_200_000, scopes: ["user:inference", "user:profile"],
    } });
  });
  await withTokenEndpoint((_request, response) => json(response, 200, { access_token: "new-access", expires_in: 3600 }), async () => {
    const result = await defaultClaudeRefreshTransport(2_000, () => NOW)(REFRESH);
    assert.equal(result.kind, "success");
    if (result.kind !== "success") return;
    assert.equal(result.token.refreshToken, REFRESH, "a response without a rotated token keeps the presented one");
    assert.equal("refreshTokenExpiresAt" in result.token, false, "an absent lifetime is not invented");
  });
});

test("refresh transport: 400/401/403 are definitive rejections that keep the provider's reason and never the token", async () => {
  for (const status of [400, 401, 403]) {
    await withTokenEndpoint((_request, response) => json(response, status, { error: "invalid_grant", error_description: `Refresh token ${REFRESH} not found or invalid` }), async () => {
      const result = await defaultClaudeRefreshTransport(2_000)(REFRESH);
      assert.deepEqual(result, { kind: "rejected", httpStatus: status, error: "invalid_grant", description: "Refresh token [redacted] not found or invalid" });
      assert.ok(!JSON.stringify(result).includes(REFRESH));
    });
  }
  await withTokenEndpoint((_request, response) => json(response, 401, { type: "error", error: { type: "authentication_error", message: "OAuth token has been revoked" } }), async () => {
    assert.deepEqual(await defaultClaudeRefreshTransport(2_000)(REFRESH), { kind: "rejected", httpStatus: 401, error: "authentication_error", description: "OAuth token has been revoked" });
  });
  await withTokenEndpoint((_request, response) => { response.writeHead(400); response.end("<html>nope</html>"); }, async () => {
    assert.deepEqual(await defaultClaudeRefreshTransport(2_000)(REFRESH), { kind: "rejected", httpStatus: 400, error: null, description: null });
  });
});

test("refresh transport: 429, 503 and a refused connection leave the token unconsumed", async () => {
  await withTokenEndpoint((_request, response) => json(response, 429, { error: { type: "rate_limit_error", message: "slow down" } }, { "Retry-After": "120" }), async () => {
    assert.deepEqual(await defaultClaudeRefreshTransport(2_000)(REFRESH), { kind: "retryable", httpStatus: 429, error: "rate_limit_error", description: "slow down", retryAfterMs: 120_000 });
  });
  await withTokenEndpoint((_request, response) => { response.writeHead(503); response.end("upstream unavailable"); }, async () => {
    assert.deepEqual(await defaultClaudeRefreshTransport(2_000)(REFRESH), { kind: "retryable", httpStatus: 503, error: null, description: null });
  });
  const closed = await withTokenEndpoint(() => undefined, async (url) => url);
  const previous = process.env.HIVE_CLAUDE_OAUTH_TOKEN_URL;
  process.env.HIVE_CLAUDE_OAUTH_TOKEN_URL = closed;
  try {
    assert.deepEqual(await defaultClaudeRefreshTransport(2_000)(REFRESH), { kind: "retryable", httpStatus: null, error: null, description: "connection failed before the request was sent (ECONNREFUSED)" });
  } finally {
    if (previous === undefined) delete process.env.HIVE_CLAUDE_OAUTH_TOKEN_URL;
    else process.env.HIVE_CLAUDE_OAUTH_TOKEN_URL = previous;
  }
});

test("refresh transport: no answer after the request was sent is an unknown outcome", async () => {
  await withTokenEndpoint(() => undefined, async () => {
    assert.deepEqual(await defaultClaudeRefreshTransport(150)(REFRESH), { kind: "unknown_outcome", description: "no response within 150 ms" });
  });
  await withTokenEndpoint((request) => request.socket.destroy(), async () => {
    const result = await defaultClaudeRefreshTransport(2_000)(REFRESH);
    assert.equal(result.kind, "unknown_outcome");
  });
  // A gateway can answer 502/504 after the provider committed the rotation; a bare 500 says nothing either.
  for (const status of [500, 502, 504]) {
    await withTokenEndpoint((_request, response) => json(response, status, { type: "error", error: { type: "api_error", message: "upstream failed" } }), async () => {
      assert.deepEqual(await defaultClaudeRefreshTransport(2_000)(REFRESH), { kind: "unknown_outcome", description: `HTTP ${status} api_error: upstream failed after the request was sent` });
    });
  }
  await withTokenEndpoint((_request, response) => json(response, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), async () => {
    assert.deepEqual(await defaultClaudeRefreshTransport(2_000)(REFRESH), { kind: "retryable", httpStatus: 529, error: "overloaded_error", description: "Overloaded" });
  });
  await withTokenEndpoint((_request, response) => { response.writeHead(200); response.end("not json"); }, async () => {
    assert.deepEqual(await defaultClaudeRefreshTransport(2_000)(REFRESH), { kind: "unknown_outcome", description: "HTTP 200 with an unparseable token response" });
  });
  await withTokenEndpoint((_request, response) => json(response, 200, { refresh_token: "rotated-but-no-access" }), async () => {
    assert.deepEqual(await defaultClaudeRefreshTransport(2_000)(REFRESH), { kind: "unknown_outcome", description: "HTTP 200 without an access token" });
  });
});

test("refresh transport: provider text is allowlisted, bounded and stripped of token-shaped content", () => {
  assert.deepEqual(oauthErrorOf({ error: "made_up_code", error_description: "x".repeat(40) }), { error: null, description: "[redacted]" });
  assert.deepEqual(oauthErrorOf("invalid_grant"), { error: null, description: null });
  assert.equal(sanitizeProviderText("token sk-ant-ort01-abcDEF_123 was\n revoked"), "token [redacted] was revoked");
  assert.equal(sanitizeProviderText(`a ${"word ".repeat(80)}`)!.length, 200);
  assert.equal(describeRefreshFailure({ httpStatus: 400, error: "invalid_grant", description: "gone" }), "HTTP 400 invalid_grant: gone");
  assert.equal(describeRefreshFailure({ httpStatus: null, error: null, description: "no response within 150 ms" }), "no response within 150 ms");
  assert.equal(describeRefreshFailure({ httpStatus: 503, error: null, description: null }), "HTTP 503");
});

test("login transport: the token exchange records the login's own expiry", async () => {
  await withTokenEndpoint((_request, response, body) => {
    assert.equal(JSON.parse(body).grant_type, "authorization_code");
    json(response, 200, { access_token: "login-access", refresh_token: "login-refresh", expires_in: 28_800, refresh_token_expires_in: 2_419_200 });
  }, async () => {
    const before = Date.now();
    const grant = await defaultLoginTransports(2_000).claudeTokenExchange({ code: "c", state: "s", codeVerifier: "v", redirectUri: "https://example.invalid/cb", clientId: "client" });
    assert.ok(grant);
    assert.ok(grant.refreshTokenExpiresAt! >= before + 2_419_200_000 && grant.refreshTokenExpiresAt! <= Date.now() + 2_419_200_000);
  });
  await withTokenEndpoint((_request, response) => json(response, 200, { access_token: "login-access", refresh_token: "login-refresh", expires_in: 28_800 }), async () => {
    const grant = await defaultLoginTransports(2_000).claudeTokenExchange({ code: "c", state: "s", codeVerifier: "v", redirectUri: "https://example.invalid/cb", clientId: "client" });
    assert.equal("refreshTokenExpiresAt" in grant!, false);
  });
});
