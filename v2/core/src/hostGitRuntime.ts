import { spawnSync } from "node:child_process";

export class HostGitRefused extends Error {
  readonly code = "host_git_refused";
  readonly reason: "unsupported_version" | "version_unavailable" | "missing_objects";
  constructor(reason: "unsupported_version" | "version_unavailable" | "missing_objects", detail: string) {
    super(`Host Git refused: ${detail}`);
    this.name = "HostGitRefused";
    this.reason = reason;
  }
}

export function assertHostGitVersion(cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync("git", ["--version"], { cwd, env, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/m.exec(result.stdout ?? "");
  if (result.error || result.status !== 0 || !match) throw new HostGitRefused("version_unavailable", "cannot verify the required Git >=2.44; install a supported Git before operating on this checkout");
  const major = Number(match[1]), minor = Number(match[2]);
  if (major < 2 || major === 2 && minor < 44) throw new HostGitRefused("unsupported_version", `Git >=2.44 is required for host checkout operations; found ${match[0].slice(4)}`);
}

export function refuseMissingGitObjects(status: number | null, stderr: string): void {
  if (status !== 0 && /\bbad object\b|\bmissing (?:blob|tree|commit|object)\b|\bunable to read (?:tree|object)\b|\bcould not read [0-9a-f]{40,64}\b/i.test(stderr)) {
    throw new HostGitRefused("missing_objects", "checkout objects are unavailable; reprovision or hydrate the checkout through an approved owner");
  }
}
