import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { devNull, homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { hostGitEnv } from "./git.ts";

export interface UpstreamSshPolicy {
  identityFiles: string[];
  knownHostsFile: string;
}

export const UPSTREAM_FETCH_FAILURES = ["ssh_policy_invalid", "host_key_refused", "ssh_auth_refused", "https_auth_unsupported", "invalid_objects", "transport_refused", "provenance_refused", "fetch_failed"] as const;
export type UpstreamFetchFailure = typeof UPSTREAM_FETCH_FAILURES[number];

export class UpstreamFetchError extends Error {
  readonly code: UpstreamFetchFailure;
  constructor(code: UpstreamFetchFailure, message: string) {
    super(message);
    this.name = "UpstreamFetchError";
    this.code = code;
  }
}

export function resolveUpstreamSshPolicy(raw: unknown, configDir: string, home = homedir()): UpstreamSshPolicy {
  if (raw === undefined) return { identityFiles: [join(home, ".ssh", "id_ed25519"), join(home, ".ssh", "id_rsa")], knownHostsFile: join(home, ".ssh", "known_hosts") };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new UpstreamFetchError("ssh_policy_invalid", "upstreamSsh must contain identityFiles and knownHostsFile");
  const c = raw as Record<string, unknown>;
  const valid = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !/[%\x00\r\n]/u.test(v);
  if (!Array.isArray(c.identityFiles) || c.identityFiles.length === 0 || !c.identityFiles.every(valid) || !valid(c.knownHostsFile)) throw new UpstreamFetchError("ssh_policy_invalid", "upstreamSsh requires nonempty identityFiles and knownHostsFile paths");
  return { identityFiles: c.identityFiles.map((p) => resolve(configDir, p)), knownHostsFile: resolve(configDir, c.knownHostsFile) };
}

function checkedFile(path: string, optional: boolean, publicFile = false): boolean {
  if (!isAbsolute(path) || /[%\x00\r\n]/u.test(path)) throw new UpstreamFetchError("ssh_policy_invalid", "upstream SSH paths must be absolute without SSH expansion tokens");
  let current = parse(path).root;
  const parts = path.slice(current.length).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    let info;
    try { info = lstatSync(current); } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new UpstreamFetchError("ssh_policy_invalid", "upstream SSH file is missing or unreadable");
    }
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new UpstreamFetchError("ssh_policy_invalid", "upstream SSH path must contain only real directories and a regular file");
    const forbiddenMode = publicFile && i === parts.length - 1 ? 0o022 : 0o077;
    if (i >= parts.length - 2 && ((process.getuid && info.uid !== process.getuid()) || (info.mode & forbiddenMode) !== 0)) throw new UpstreamFetchError("ssh_policy_invalid", "upstream SSH paths must be daemon-owned and protected against access or modification by other users");
  }
  if (realpathSync(path) !== path) throw new UpstreamFetchError("ssh_policy_invalid", "upstream SSH path must be canonical");
  return true;
}

export function validatedUpstreamSsh(policy: UpstreamSshPolicy): UpstreamSshPolicy {
  checkedFile(policy.knownHostsFile, false, true);
  const identityFiles = policy.identityFiles.filter((path) => checkedFile(path, true));
  if (identityFiles.length === 0) throw new UpstreamFetchError("ssh_policy_invalid", "no valid upstream SSH identity is available; keeping the last mirror");
  return { identityFiles, knownHostsFile: policy.knownHostsFile };
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function upstreamFetchEnv(cwd: string, url: string, ssh: UpstreamSshPolicy | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(GIT_|GCM_|SSH_|GPG_|GNUPG|CURL_|SSL_CERT_|https?_proxy$|all_proxy$)/iu.test(key)) base[key] = value;
  const local = isAbsolute(url) || url.startsWith("file://");
  const https = url.startsWith("https://");
  const sshUrl = url.startsWith("ssh://") || /^[^\s/:]+@[^\s/:]+:/u.test(url);
  if (!local && !https && !sshUrl) throw new UpstreamFetchError("transport_refused", "upstream fetch allows only HTTPS, SSH and explicit local repositories");
  if (https) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new UpstreamFetchError("https_auth_unsupported", "authenticated HTTPS upstreams require an explicit credential policy; use configured SSH identities");
  }
  let command = "/bin/false";
  if (sshUrl) {
    const policy = validatedUpstreamSsh(ssh ?? resolveUpstreamSshPolicy(undefined, "."));
    command = ["/usr/bin/ssh", "-F", devNull, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${JSON.stringify(policy.knownHostsFile)}`, "-o", `GlobalKnownHostsFile=${devNull}`, "-o", "ProxyCommand=none", "-o", "ProxyJump=none", ...policy.identityFiles.flatMap((path) => ["-i", path])].map(quote).join(" ");
  }
  const env = base;
  Object.assign(env, { HOME: devNull, XDG_CONFIG_HOME: devNull, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: local ? "file" : "https:ssh", GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: "ssh", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", GCM_INTERACTIVE: "never" });
  const overrides: Array<readonly [string, string]> = [
    ["core.gitProxy", ""], ["core.askPass", "/bin/false"], ["core.sshCommand", command],
    ["gpg.program", "/bin/false"], ["gpg.ssh.program", "/bin/false"], ["commit.gpgSign", "false"], ["log.showSignature", "false"],
    ["credential.helper", ""], ["credential.interactive", "false"], ["http.extraHeader", ""], ["http.cookieFile", ""], ["http.saveCookies", "false"], ["http.sslVerify", "true"], ["http.proxy", ""], ["http.followRedirects", "false"], ["http.sslCert", ""], ["http.sslKey", ""],
    ["fetch.fsckObjects", "true"], ["transfer.fsckObjects", "true"], ["fetch.recurseSubmodules", "false"], ["gc.auto", "0"],
  ];
  const listed = spawnSync("git", ["config", "--list", "--name-only", "--null", "--includes"], { cwd, env: hostGitEnv(env, overrides), encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (listed.error || listed.status !== 0) throw new UpstreamFetchError("fetch_failed", "cannot inspect upstream repository configuration");
  for (const key of listed.stdout.split("\0")) {
    if (/^(?:fetch|receive|transfer)\.fsck\.|^fsck\./iu.test(key)) throw new UpstreamFetchError("transport_refused", "upstream fetch refuses repository object-validation overrides");
    if (/^url\..+\.(?:insteadof|pushinsteadof)$/iu.test(key)) throw new UpstreamFetchError("transport_refused", "upstream fetch refuses repository URL rewrites");
    const remote = /^remote\.(.*)\.([^.]+)$/iu.exec(key);
    if (remote && (!/^[a-z0-9][a-z0-9_.-]*$/iu.test(remote[1]!) || !/^(?:url|fetch|pushurl|mirror|tagopt|prune|promisor|partialclonefilter)$/iu.test(remote[2]!))) throw new UpstreamFetchError("transport_refused", "upstream fetch refuses URL-named remotes and executable remote transport settings");
    if (/^http\./iu.test(key) && !/^http\.(?:.*\.)?(?:extraheader|cookiefile|proxy|sslcert|sslkey|savecookies|sslverify|followredirects)$/iu.test(key)) throw new UpstreamFetchError("transport_refused", "upstream fetch refuses unsupported HTTP configuration");
    if (/^credential\..+\.helper$/iu.test(key) || /^http\..+\.(?:extraheader|cookiefile|proxy|sslcert|sslkey)$/iu.test(key)) overrides.push([key, ""]);
    if (/^http\..+\.followredirects$/iu.test(key)) overrides.push([key, "false"]);
    if (/^http\..+\.savecookies$/iu.test(key)) overrides.push([key, "false"]);
    if (/^http\..+\.sslverify$/iu.test(key)) overrides.push([key, "true"]);
  }
  return hostGitEnv(env, overrides);
}

export function upstreamFetchFailure(stderr: string): UpstreamFetchFailure {
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/iu.test(stderr)) return "host_key_refused";
  if (/Permission denied \([^)]*publickey/iu.test(stderr)) return "ssh_auth_refused";
  if (/could not read Username|Authentication failed|terminal prompts disabled|HTTP.*40[13]/iu.test(stderr)) return "https_auth_unsupported";
  if (/fsck|corrupt|inflate|hash mismatch|bad object|invalid object|missing blob|did not send all necessary objects|unpack.*(?:failed|error)/iu.test(stderr)) return "invalid_objects";
  return "fetch_failed";
}
