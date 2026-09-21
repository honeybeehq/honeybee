import { parseDistributionProfile, productionProfile, distributionIdentity, type DistributionProfile } from "./distribution-profile.js";
/** GitHub boundary: create-only draft assets, repository immutability, and evaluator notification. */
import type { HoneybeeReleaseEvent, ReleaseAssetStore } from "./publish.js";

type Release = { id: number; tag_name: string; draft: boolean; immutable: boolean };
type Asset = { id: number; name: string; state: string; size: number };
/** Requires one writer per distribution tag, enforced by release.yml concurrency.
 * GitHub has no conditional asset delete; this ownership fence also permits safe
 * recovery of empty starter placeholders left by interrupted uploads.
 */
export class GitHubReleaseStore implements ReleaseAssetStore {
  private release: Release | null = null;
  private readonly repo: string;
  constructor(private readonly tag: string, private readonly token: string, private readonly request: typeof fetch = fetch, profile: DistributionProfile = productionProfile) {
    this.repo = parseDistributionProfile(profile).repository;
    if (!/^honeybee-v\d+\.\d+\.\d+-(darwin-arm64|linux-x64)$/.test(tag)) throw new Error("Unsupported release tag/target");
    if (!token) throw new Error("Distribution token required");
  }
  url(name: string) { return `https://github.com/${this.repo}/releases/download/${this.tag}/${encodeURIComponent(name)}`; }
  private async api(path: string, init: RequestInit = {}, allow404 = false) {
    const response = await this.request(`https://api.github.com/repos/${this.repo}${path}`, { ...init, headers: {
      Accept: "application/vnd.github+json", "Content-Type": "application/json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2026-03-10", ...init.headers }, signal: AbortSignal.timeout(120_000) });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub release request failed (${response.status}): ${path}`);
    return response;
  }
  private async find(): Promise<Release | null> {
    // Authenticated release listings include drafts; tags endpoint alone does not reliably find them.
    for (let page = 1; ; page++) {
      const entries = await (await this.api(`/releases?per_page=100&page=${page}`))!.json() as Release[];
      const release = entries.find(r => r.tag_name === this.tag);
      if (release) return release;
      if (entries.length < 100) return null;
    }
  }
  async open(): Promise<void> {
    const setting = await this.api("/immutable-releases", {}, true);
    if (!setting || (await setting.json() as { enabled?: boolean }).enabled !== true) throw new Error("Distribution repository must enable immutable releases before publication");
    this.release = await this.find();
    if (!this.release) {
      try {
        this.release = await (await this.api("/releases", { method: "POST", body: JSON.stringify({ tag_name: this.tag,
          name: this.tag, draft: true, make_latest: "false", body: "Immutable Honeybee runtime. See release.json for exact source, artifact and inventory identities. Activation remains hive deploy." }) }))!.json() as Release;
      } catch (error) {
        this.release = await this.find();
        if (!this.release) throw error;
      }
    }
    if (!this.release.draft && !this.release.immutable) throw new Error("Existing release is not immutable");
  }
  private current(): Release {
    if (!this.release) throw new Error("Open the release store first");
    return this.release;
  }
  async read(name: string): Promise<Uint8Array | null> {
    const release = this.current();
    for (let page = 1; ; page++) {
      const assets = await (await this.api(`/releases/${release.id}/assets?per_page=100&page=${page}`))!.json() as Asset[];
      const asset = assets.find(a => a.name === name);
      if (asset) {
        if (asset.state !== "uploaded") {
          const currentRelease = await (await this.api(`/releases/${release.id}`))!.json() as Release;
          const currentAsset = await (await this.api(`/releases/assets/${asset.id}`))!.json() as Asset;
          if (!currentRelease.draft || currentAsset.state !== "starter" || currentAsset.size !== 0) {
            throw new Error(`Incomplete GitHub asset: ${name}; refusing to replace nonempty or published bytes`);
          }
          await this.api(`/releases/assets/${asset.id}`, { method: "DELETE" });
          return null;
        }
        return new Uint8Array(await (await this.api(`/releases/assets/${asset.id}`, { headers: { Accept: "application/octet-stream" } }))!.arrayBuffer());
      }
      if (assets.length < 100) return null;
    }
  }
  async put(name: string, bytes: Uint8Array): Promise<void> {
    const release = this.current();
    if (!release.draft) throw new Error("Published assets cannot change");
    const response = await this.request(`https://uploads.github.com/repos/${this.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/octet-stream", "X-GitHub-Api-Version": "2026-03-10" },
      body: Buffer.from(bytes), signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`GitHub asset upload failed (${response.status}): ${name}`);
  }
  async seal(): Promise<void> {
    const release = this.current();
    const current = await (await this.api(`/releases/${release.id}`))!.json() as Release;
    if (current.draft) await this.api(`/releases/${release.id}`, { method: "PATCH", body: JSON.stringify({ draft: false, make_latest: "false" }) });
    this.release = await (await this.api(`/releases/${release.id}`))!.json() as Release;
    if (this.release.draft || !this.release.immutable) throw new Error("GitHub did not confirm immutable publication");
  }
}

export async function notifyHoneybeeRelease(event: HoneybeeReleaseEvent, token: string, request: typeof fetch = fetch, profile: DistributionProfile = productionProfile): Promise<void> {
  profile = parseDistributionProfile(profile);
  const prefix = `https://github.com/${profile.repository}/releases/download/`;
  if (!event.descriptor.url.startsWith(prefix) || (profile.id === "production" ? event.distribution !== undefined : event.distribution !== distributionIdentity(profile))) throw new Error("Notification distribution mismatch");
  if (!token) throw new Error("Evaluator notification token unavailable");
  const response = await request("https://api.github.com/repos/honeybeehq/apiary/dispatches", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
    body: JSON.stringify({ event_type: profile.id === "production" ? "honeybee-release-published-v1" : "honeybee-staging-release-published-v1", client_payload: event }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Evaluator notification failed (${response.status})`);
}
