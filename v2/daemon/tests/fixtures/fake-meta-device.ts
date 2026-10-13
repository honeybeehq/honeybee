/**
 * A loopback stand-in for Meta's OIDC device endpoints
 * (`/oidc/device/authorization/`, `/oidc/device/token/`). Each request's
 * form is recorded; the token endpoint answers from a script whose last
 * entry repeats. Tokens it hands out are DUMMY values.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeMetaResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface FakeMetaDevice {
  url: string;
  requests: Array<{ path: string; form: Record<string, string>; contentType: string | undefined }>;
  /** Replace the token endpoint's script (the last entry repeats). */
  script: (responses: FakeMetaResponse[]) => void;
  close: () => Promise<void>;
}

export const PENDING: FakeMetaResponse = { status: 400, body: { error: "authorization_pending" } };
export const SLOW_DOWN: FakeMetaResponse = { status: 400, body: { error: "slow_down" } };
export const DENIED: FakeMetaResponse = { status: 400, body: { error: "access_denied" } };
export const EXPIRED: FakeMetaResponse = { status: 400, body: { error: "expired_token" } };

export function granted(overrides: Record<string, unknown> = {}): FakeMetaResponse {
  return { status: 200, body: { access_token: "DUMMY-ACCESS-0001", refresh_token: "DUMMY-REFRESH-0001", token_type: "Bearer", expires_in: 3600, ...overrides } };
}

export function deviceAuthorization(overrides: Record<string, unknown> = {}): FakeMetaResponse {
  return {
    status: 200,
    body: {
      device_code: "DUMMY-DEVICE-CODE",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.meta.com/oauth/device/",
      verification_uri_complete: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
      expires_in: 900,
      interval: 5,
      ...overrides,
    },
  };
}

export async function startFakeMetaDevice(opts: { authorization?: FakeMetaResponse; token?: FakeMetaResponse[] } = {}): Promise<FakeMetaDevice> {
  const authorization = opts.authorization ?? deviceAuthorization();
  let tokens = opts.token ?? [PENDING];
  const requests: FakeMetaDevice["requests"] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      requests.push({ path, form: Object.fromEntries(new URLSearchParams(raw)), contentType: req.headers["content-type"] });
      let reply: FakeMetaResponse = { status: 404, body: { error: "not_found" } };
      if (req.method === "POST" && path === "/oidc/device/authorization/") reply = authorization;
      if (req.method === "POST" && path === "/oidc/device/token/") reply = tokens.length > 1 ? tokens.shift()! : tokens[0]!;
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    script: (responses) => {
      tokens = responses;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
