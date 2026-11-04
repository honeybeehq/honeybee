import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { UpstreamFetchError } from "./upstreamFetch.ts";

export function productSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'product'
  )
}

export function normalizeGitOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  const trimmed = origin.trim()
  if (!trimmed || /[\r\n]/.test(trimmed)) return undefined
  const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(trimmed)
  if (scp) {
    const path = scp[2]!.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
    return path ? `${scp[1]!.toLowerCase()}/${path.toLowerCase()}` : undefined
  }
  const file = /^file:\/\/(.+)$/i.exec(trimmed)
  if (file) {
    const path = file[1]!.replace(/\/+$/g, '').replace(/\.git$/i, '')
    return path ? `file:///${path.replace(/^\/+/, '')}` : undefined
  }
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(trimmed)
  if (url) {
    const path = url[2]!.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
    return path ? `${url[1]!.toLowerCase()}/${path.toLowerCase()}` : undefined
  }
  const path = trimmed
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
  return path.includes('/') ? path : undefined
}

export const CHECKOUT_NAME_HASH_CHARS = 12
export const CHECKOUT_NAME_MAX = 80
export function formatCheckoutName(origin: string, sha256Hex: string): string | undefined {
  const hash = sha256Hex.trim().toLowerCase()
  if (!/^[0-9a-f]{12,}$/.test(hash)) return undefined
  const suffix = hash.slice(0, CHECKOUT_NAME_HASH_CHARS)
  const slug = productSlug(origin.replace(/[/:]/g, '-'))
  const budget = CHECKOUT_NAME_MAX - 1 - suffix.length
  const prefix = slug.slice(0, Math.max(1, budget)).replace(/-+$/g, '') || 'repo'
  return `${prefix}-${suffix}`
}

export function ownerCheckoutName(origin: string): string {
  const digest = createHash('sha256').update(origin).digest('hex')
  const name = formatCheckoutName(origin, digest)
  if (!name) throw new Error('origin produced no checkout name')
  return name
}

export function verifiedUpstreamUrl(originRepo: string, candidates: string[], allowLocalFixture = false): string {
  if (candidates.length !== 1 || !candidates[0]) throw new UpstreamFetchError("provenance_refused", "upstream fetch requires exactly one URL; leaving the cache unchanged");
  const value = candidates[0];
  if (allowLocalFixture && (isAbsolute(value) || value.startsWith("file://"))) return value;
  if (/[^\x21-\x7e]|[%?#\\]/u.test(value) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(value)) throw new UpstreamFetchError("provenance_refused", "upstream URL contains unsupported syntax; leaving the cache unchanged");
  let host: string, path: string;
  const scp = /^git@([a-z0-9.-]+):([a-z0-9._/-]+)$/iu.exec(value);
  if (scp) { host = scp[1]!; path = scp[2]!; }
  else {
    let url: URL;
    try { url = new URL(value); } catch { throw new UpstreamFetchError("provenance_refused", "upstream fetch requires a strict SSH or HTTPS URL"); }
    if (url.protocol !== "ssh:" && url.protocol !== "https:" || url.password || url.protocol === "ssh:" && url.username !== "git" || url.protocol === "https:" && url.username || url.port && !(url.protocol === "ssh:" && url.port === "22") || !/^[a-z0-9.-]+$/iu.test(url.hostname) || !/^\/[a-z0-9._/-]+$/iu.test(url.pathname)) throw new UpstreamFetchError("provenance_refused", "upstream URL requires HTTPS without userinfo or SSH with fixed git user and default port");
    host = url.hostname;
    path = url.pathname.slice(1);
  }
  const segments = path.replace(/\/$/u, "").split("/");
  if (host.startsWith("-") || host.endsWith(".") || host.includes("..") || segments.length < 2 || !segments.at(-1)!.replace(/\.git$/iu, "") || segments.some(segment => !segment || segment === "." || segment === ".." || segment.startsWith("-"))) throw new UpstreamFetchError("provenance_refused", "upstream URL has unsupported host or repository path");
  const canonical = normalizeGitOrigin(value);
  if (!canonical || basename(originRepo) !== ownerCheckoutName(canonical)) throw new UpstreamFetchError("provenance_refused", "upstream URL does not match an Apiary-derived origin name; custom placements require an explicit trusted binding; leaving the cache unchanged");
  return value;
}
