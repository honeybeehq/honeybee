const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isTestDaemonEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(env).some((key) => key.startsWith("HIVE_TEST_"));
}

function requestUrl(input: unknown): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof input === "object" && "url" in input && typeof (input as { url: unknown }).url === "string") return new URL((input as { url: string }).url);
  } catch {
    return null;
  }
  return null;
}

function redirectedByTestPreload(url: URL): URL | null {
  if ((globalThis as { __hiveMetaLoopback?: unknown }).__hiveMetaLoopback !== true) return null;
  const target = process.env.HIVE_TEST_META_URL;
  if (!target) return null;
  const loopback = requestUrl(target);
  if (!loopback || !LOOPBACK_HOSTS.has(loopback.hostname)) return null;
  if (url.origin !== "https://auth.meta.com" && url.href !== "https://api.meta.ai/muse-code/key") return null;
  return new URL(`${loopback.href.replace(/\/+$/, "")}${url.pathname}${url.search}`);
}

/**
 * Guard global fetch only (not node:http, sockets, or harness subprocesses).
 * A test daemon fetch may only talk to loopback. Every provider
 * default (OAuth token, usage, profile, limits, models) is a real host, so a
 * test that forgets one override must fail at the call, never reach it.
 */
export function refuseNonLoopbackFetch(log: (op: string) => void = () => undefined): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = requestUrl(input);
    const redirected = url ? redirectedByTestPreload(url) : null;
    if (!url || !(LOOPBACK_HOSTS.has(url.hostname) || redirected)) {
      const target = url ? url.host : String(input);
      log(`test.network.refused host=${target}`);
      throw new Error(`test daemon refused a non-loopback request to ${target}; point the test at a local stub`);
    }
    // A loopback stub must not redirect the underlying fetch to a provider.
    // Manual redirects remain inspectable; automatic redirects fail closed.
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    const request = redirected ? (input instanceof Request ? new Request(redirected, input) : redirected) : input;
    return realFetch(request, { ...init, redirect: redirect === "manual" ? "manual" : "error" });
  }) as typeof fetch;
}
