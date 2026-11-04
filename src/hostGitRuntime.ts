import {statSync,realpathSync} from "node:fs";
import {delimiter,join,resolve} from "node:path";
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

const versionChecks=new Map<string,string>();

function executableKey(cwd:string,env:NodeJS.ProcessEnv): {path:string;key:string} {
  for(const entry of (env.PATH??"/usr/bin:/bin").split(delimiter)) {
    const path=resolve(cwd,join(entry||".","git"));
    try {
      const resolved=realpathSync(path), info=statSync(resolved,{bigint:true});
      if(!info.isFile()||(info.mode&0o111n)===0n)continue;
      return {path:resolved,key:[env.PATH??"",path,resolved,info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs,info.mode].join("\0")};
    } catch {}
  }
  throw new HostGitRefused("version_unavailable","cannot resolve the required Git >=2.44 executable");
}

export function assertHostGitVersion(cwd: string, env: NodeJS.ProcessEnv): string {
  const executable=executableKey(cwd,env);
  if(versionChecks.get(executable.path)===executable.key)return executable.path;
  const result = spawnSync(executable.path, ["--version"], { cwd, env, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/m.exec(result.stdout ?? "");
  if (result.error || result.status !== 0 || !match) throw new HostGitRefused("version_unavailable", "cannot verify the required Git >=2.44; install a supported Git before operating on this checkout");
  const major = Number(match[1]), minor = Number(match[2]);
  if (major < 2 || major === 2 && minor < 44) throw new HostGitRefused("unsupported_version", `Git >=2.44 is required for host checkout operations; found ${match[0].slice(4)}`);
  versionChecks.set(executable.path,executable.key);
  return executable.path;
}

export function hasMissingGitObjects(status: number | null, stderr: string): boolean {
  return status !== 0 && /\bbad object\b|\bmissing (?:blob|tree|commit|object)\b|\bunable to read (?:tree|object)\b|\bcould not read [0-9a-f]{40,64}\b/i.test(stderr);
}

export function refuseMissingGitObjects(status: number | null, stderr: string): void {
  if (hasMissingGitObjects(status,stderr)) {
    throw new HostGitRefused("missing_objects", "checkout objects are unavailable; reprovision or hydrate the checkout through an approved owner");
  }
}
