import { prepareSandboxHarnessHome } from "./harnessHome.ts";
/**
 * Cell sandbox wrapper (WP5, spec 05 point 5 — the A4 ruling).
 *
 * The sandbox wraps the INNER spawn command (the harness CLI) with an OS
 * confinement layer: Seatbelt (`sandbox-exec`) on darwin, bwrap on linux.
 * Policy: the filesystem is read-visible but write-confined to the cell,
 * the harness's own home/state dirs, package-manager caches and the usual
 * scratch space; the network is allowed (agents talk to providers).
 *
 * Defaults by node kind (A4): workstation OFF, satellite ON, cloud gateway
 * OFF (the ephemeral VM is the boundary there). Per-cell override wins.
 */
import { cellCliBundlePath, cellScopeArtifactDirectory, validatedCellScopeBinary } from "./cellScope.ts";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve as resolvePath, sep } from "node:path";

export type NodeKind = "workstation" | "satellite" | "cloud";

export const NODE_KINDS: readonly NodeKind[] = ["workstation", "satellite", "cloud"];

/** A4: sandbox default per node kind. */
export function sandboxDefaultFor(kind: NodeKind): boolean {
  return kind === "satellite";
}

/** Effective sandbox decision: per-cell override > node-kind default. */
export function sandboxEnabled(kind: NodeKind, cellOverride: boolean | null | undefined): boolean {
  return cellOverride ?? sandboxDefaultFor(kind);
}

export interface SandboxPolicy {
  /** The cell wrapper dir — the primary writable subtree. */
  cellDir: string;
  /** Harness home/state dirs and caches that must stay writable. */
  writablePaths: string[];
  /** OS scratch dirs kept writable. Defaults to the platform list. */
  scratchPaths?: string[];
  tmpfsBytes?: number | null;
  kvm?: boolean;
  protectedPaths?: readonly string[];
  hiddenPaths?: readonly string[];
  gatewaySocketPath?: string;
  homePaths?: readonly string[];
  harnessHome?: { harness: string; path: string; cwd: string };
}

export const DEFAULT_SANDBOX_TMPFS_BYTES = 1024 * 1024 * 1024;

const BWRAP_PRIVATE_MOUNTS = ["/tmp", "/var/tmp"].filter((mount) => mount === "/tmp" || isRealDirectory(mount));

export const SANDBOX_TMPFS_PATHS: readonly string[] = [...BWRAP_PRIVATE_MOUNTS, "/dev/shm"];

let darwinUserTemp: string | null | undefined;

/** The user's own DARWIN_USER_TEMP_DIR (macOS mktemp writes there whatever TMPDIR says); null when unknown. */
export function darwinUserTempDir(): string | null {
  if (darwinUserTemp !== undefined) return darwinUserTemp;
  const out = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 2_000 });
  let dir: string | null = null;
  try {
    dir = out.status === 0 ? realpathSync(out.stdout.trim()) : null;
  } catch {
    dir = null;
  }
  darwinUserTemp = dir !== null && dir.startsWith("/private/var/folders/") && dir.split("/").length === 7 && dir.endsWith("/T") ? dir : null;
  return darwinUserTemp;
}

/**
 * OS scratch space every process needs writable (default scratch policy).
 * On darwin only the user's own temp dir of /private/var/folders is granted,
 * falling back to all of /private/var/folders when it cannot be resolved.
 * Residual: anything that writes DARWIN_USER_CACHE_DIR (Apple frameworks,
 * some Electron caches) now fails inside the darwin sandbox; diagnose it with
 * scripts/sandbox-trace.mjs, the Seatbelt deny-trace audit path. The grant was
 * chosen from real Claude and Codex traces; Muse was not run on darwin (no
 * mini has muse or an account, and it never runs on the Studio), and P6b is
 * the follow-up.
 */
export function defaultScratchPaths(
  osPlatform: string = platform(),
  userTemp: string | null = osPlatform === "darwin" ? darwinUserTempDir() : null,
): string[] {
  return osPlatform === "darwin"
    ? ["/tmp", "/private/tmp", "/private/var/tmp", userTemp ?? "/private/var/folders", "/dev"]
    : ["/tmp", "/var/tmp", "/dev"];
}

/**
 * Harness home + cache dirs that stay visible AND writable inside the
 * sandbox (spec: "manager download caches remain visible via the sandbox
 * profile, so cold installs stay network-warm").
 */
export function defaultWritablePaths(_home: string = homedir()): string[] {
  return [];
}

export function sandboxProtectedPaths(home: string = homedir()): string[] {
  return [".config", ".local", ".ssh", ".gnupg", ".hive", ".nectar", ".claude", ".claude.json",
    ".codex", ".grok", ".gemini", ".kimi", ".cache", ".npm", ".bun", ".bashrc", ".profile",
    ".bash_profile", ".zshrc", ".zprofile", "Library/LaunchAgents", "Library/Caches"]
    .map(path => join(home, path));
}

function hiddenPaths(policy: SandboxPolicy): string[] {
  return [...new Set([join(homedir(), ".config", "gh"), ...(policy.hiddenPaths ?? [])])]
    .filter(path => lstatSync(path, { throwIfNoEntry: false }))
    .map(path => {
      const canonical = realpathSync(path);
      if (!statSync(canonical).isDirectory()) throw new Error(`cell sandbox: hidden credential root is not a directory: ${path}`);
      return canonical;
    });
}

function checkedWritablePaths(policy: SandboxPolicy): string[] {
  const protectedPaths = [...sandboxProtectedPaths(), "/run", ...(policy.protectedPaths ?? []), ...(policy.harnessHome ? [policy.harnessHome.path] : [])].map(canonicalPath);
  const standardScratch = new Set([...defaultScratchPaths("linux"), ...defaultScratchPaths("darwin")]);
  const paths = [...policy.writablePaths, ...(policy.scratchPaths ?? []).filter(path => !standardScratch.has(path) && !/^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T\/?$/.test(path))];
  for (const path of paths) {
    const canonical = canonicalPath(path);
    if (!isAbsolute(path) || !containsPath(canonicalPath(policy.cellDir), canonical) || protectedPaths.some(protectedPath => containsPath(canonical, protectedPath) || containsPath(protectedPath, canonical))) {
      throw new Error(`cell sandbox: protected writable path refused: ${path}`);
    }
  }
  return policy.writablePaths;
}


export function sandboxEnvironment(cellDir: string, original: Readonly<Record<string, string>>): Record<string, string> {
  const root = join(cellDir, "sandbox-state");
  const temp = join(root, "tmp");
  const cache = join(root, "cache");
  for (const path of [root, temp, cache]) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`cell sandbox: unsafe private state: ${path}`);
    if (!info) mkdirSync(path, { mode: 0o700 });
  }
  const scratch = platform() === "linux" ? "/tmp" : temp;
  const env = { ...original, TMPDIR: scratch, TMP: scratch, TEMP: scratch, CLAUDE_CODE_TMPDIR: scratch,
    XDG_CACHE_HOME: cache, NODE_COMPILE_CACHE: join(cache, "node-compile"), npm_config_cache: join(cache, "npm"),
    npm_config_store_dir: join(cache, "pnpm"), YARN_CACHE_FOLDER: join(cache, "yarn"), PIP_CACHE_DIR: join(cache, "pip"),
    UV_CACHE_DIR: join(cache, "uv"), GOCACHE: join(cache, "go-build"), GOMODCACHE: join(cache, "go-mod"),
    GRADLE_USER_HOME: join(cache, "gradle") };
  for (const key of ["DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK", "NODE_OPTIONS"]) delete (env as Record<string, string>)[key];
  return env;
}

/** A canonical existing directory admitted through the narrow per-bee seam. */
export interface SandboxWritableDirectory {
  readonly path: string;
}

export interface SandboxWritableDirectoryOptions {
  /** Directories (and their ancestors) that are too broad to grant. */
  forbiddenDirectories?: readonly string[];
}

function canonicalPath(path: string): string {
  let cursor = resolvePath(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cursor), ...suffix);
    } catch {
      if (lstatSync(cursor, { throwIfNoEntry: false })) throw new Error(`cell sandbox: unresolved path refused: ${path}`);
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`cell sandbox: unresolved path refused: ${path}`);
      suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

/** True when `parent` is equal to or an ancestor of `child`. */
function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Validate and canonicalize a bee-specific writable directory. Unlike the
 * legacy baseline list, this authority seam never resolves relative input or
 * tolerates a missing path. Symlink aliases are judged by their real target.
 */
export function sandboxWritableDirectory(
  path: string,
  options: SandboxWritableDirectoryOptions = {},
): SandboxWritableDirectory {
  if (!isAbsolute(path)) throw new Error(`cell sandbox: bee writable path must be absolute: ${path}`);
  let canonical: string;
  try {
    if (!statSync(path).isDirectory()) throw new Error("not a directory");
    canonical = realpathSync(path);
  } catch {
    throw new Error(`cell sandbox: bee writable path must be an existing directory: ${path}`);
  }

  const osHome = canonicalPath(homedir());
  if (canonical === parse(canonical).root || containsPath(canonical, osHome)) {
    throw new Error(`cell sandbox: bee writable path is too broad: ${path} resolves to ${canonical}`);
  }
  for (const forbidden of options.forbiddenDirectories ?? []) {
    const target = canonicalPath(forbidden);
    if (containsPath(canonical, target)) {
      throw new Error(
        `cell sandbox: bee writable path resolves to or contains forbidden directory ${target}: ${path}`,
      );
    }
  }
  return { path: canonical };
}

function existingRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Preserve baseline spellings; append validated per-bee grants once each, skipping any an existing baseline path already covers. */
export function mergeSandboxWritablePaths(
  baseline: readonly string[],
  beeSpecific: readonly SandboxWritableDirectory[],
): string[] {
  const covering = baseline.filter(isAbsolute).map(existingRealpath).filter((path): path is string => path !== null);
  const added = beeSpecific
    .map((directory) => directory.path)
    .filter((path) => !covering.some((base) => containsPath(base, path)));
  return [...new Set([...baseline, ...added])];
}

const SB_ESCAPE = /(["\\])/g;

function sbPath(p: string): string {
  return `"${p.replace(SB_ESCAPE, "\\$1")}"`;
}

/**
 * Seatbelt matches RESOLVED paths (`/var/…` is a symlink to `/private/var/…`
 * on macOS); emit both spellings when they differ so a symlinked cells root
 * cannot silently escape or break the allow-list.
 */
function withRealpaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    out.add(p);
    try {
      out.add(realpathSync(p));
    } catch {
      // Path may not exist yet (harness home) — the literal spelling stands.
    }
  }
  return [...out];
}

/**
 * Seatbelt profile (darwin): allow-by-default with a global file-write deny,
 * re-allowing the cell subtree, harness homes/caches and OS scratch space.
 * Later SBPL rules win, so the allow-list overrides the deny.
 */
export function seatbeltProfile(policy: SandboxPolicy): string {
  checkedWritablePaths(policy);
  const writeAllows = withRealpaths([
    policy.cellDir,
    ...policy.writablePaths,
    ...(policy.scratchPaths ?? defaultScratchPaths("darwin")),
  ])
    .map((p) => `  (subpath ${sbPath(p)})`)
    .join("\n");
  return [
    "(version 1)",
    "; hive v2 cell sandbox — write-confined, read-open, network-open (A4)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    writeAllows,
    ")",
    ...hiddenPaths(policy).map(path => `(deny file-read* (subpath ${sbPath(path)}))`),
    "",
  ].join("\n");
}


function isRealDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function maskedLaunchRoot(path: string): string | null {
  for (const mount of BWRAP_PRIVATE_MOUNTS) {
    const rel = relative(mount, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    return join(mount, rel.split(sep)[0]!);
  }
  return null;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function bwrapLaunchBinds(command: string, args: readonly string[], cellDir: string): string[] {
  const roots = new Set<string>();
  for (const input of [command, ...args]) {
    if (!isAbsolute(input) || !isRegularFile(input) || containsPath(canonicalPath(cellDir), canonicalPath(input))) continue;
    for (const spelling of [input, realpathSync(input)]) {
      const root = maskedLaunchRoot(spelling);
      if (root) roots.add(root);
    }
  }
  for (const root of roots) {
    const pending = [{ path: root, depth: 0 }];
    let visited = 0;
    while (pending.length > 0) {
      const entry = pending.pop()!;
      if (++visited > 10000 || entry.depth > 16) throw new Error("cell sandbox: launch input tree exceeds its limit");
      const info = lstatSync(entry.path);
      if (info.isSocket() || info.isSymbolicLink() && statSync(entry.path).isSocket()) throw new Error(`cell sandbox: socket in launch input tree refused: ${entry.path}`);
      if (info.isDirectory()) for (const name of readdirSync(entry.path)) pending.push({ path: join(entry.path, name), depth: entry.depth + 1 });
    }
  }
  return [...roots].flatMap((root) => ["--ro-bind", realpathSync(root), root]);
}

export function createSshConfigView(profilePath: string, source = "/etc/ssh/ssh_config.d"): string | undefined {
  let view: string | undefined;
  try {
    const info = statSync(source, { throwIfNoEntry: false });
    if (!info) return undefined;
    if (!info.isDirectory()) throw new Error(`SSH client include path is not a directory: ${source}`);
    view = mkdtempSync(join(dirname(profilePath), "ssh-config-"));
    cpSync(source, view, {
      recursive: true,
      dereference: true,
      filter: (path) => {
        const entry = statSync(path, { throwIfNoEntry: false });
        if (!entry) return false;
        if (!entry.isFile() && !entry.isDirectory()) throw new Error(`unsupported SSH client include: ${path}`);
        return true;
      },
    });
    return view;
  } catch (error) {
    if (view) rmSync(view, { recursive: true, force: true });
    console.warn(`cell sandbox: retaining host SSH config: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * bwrap argv (linux): read-only root with the writable paths re-bound
 * read-write. Pure argv construction — testable on any platform; execution
 * is exercised by the linux gate (trmd-metal-3).
 */
export function bwrapArgs(policy: SandboxPolicy, command: string, args: string[], _sshConfigView?: string): string[] {
  checkedWritablePaths(policy);
  if ((policy.scratchPaths ?? []).some(path => !["/tmp", "/var/tmp", "/dev"].includes(path))) {
    throw new Error("cell sandbox: only Cell-owned writable paths are supported");
  }
  const projection = policy.harnessHome ? prepareSandboxHarnessHome(policy.cellDir, policy.harnessHome.harness, policy.harnessHome.path) : undefined;
  const size = policy.tmpfsBytes != null ? ["--size", String(policy.tmpfsBytes)] : [];
  const homes = [...new Set([homedir(), userInfo().homedir, ...(policy.homePaths ?? [])].map(path => realpathSync(path)))];
  const out: string[] = [
    "--unshare-user", "--unshare-pid", "--unshare-ipc",
    "--ro-bind", "/", "/", "--dev", "/dev", ...size, "--tmpfs", "/dev/shm", "--proc", "/proc",
    ...BWRAP_PRIVATE_MOUNTS.flatMap(mount => [...size, "--tmpfs", mount]),
    ...homes.flatMap(home => ["--tmpfs", home]),
    "--tmpfs", "/run", "--dir", "/run/user", "--dir", "/run/honeybee", "--dir", "/run/honeybee/bin",
    ...bwrapLaunchBinds(command, args, policy.cellDir),
    "--bind", policy.cellDir, policy.cellDir,
  ];
  if (policy.kvm) out.push("--dev-bind", "/dev/kvm", "/dev/kvm");
  if (projection) {
    for (const file of projection.files) out.push("--ro-bind", file.source, file.destination);
    out.push("--setenv", policy.harnessHome!.harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR", projection.home);
  }
  for (const path of hiddenPaths(policy)) out.push("--tmpfs", path, "--remount-ro", path);
  if (policy.gatewaySocketPath) out.push("--ro-bind", policy.gatewaySocketPath, "/run/honeybee/gateway.sock");
  const scopeDirectory = cellScopeArtifactDirectory();
  out.push("--ro-bind", join(scopeDirectory, "cell-scope"), "/run/honeybee/cell-scope",
    "--ro-bind", join(scopeDirectory, "hive"), "/run/honeybee/bin/hive",
    "--ro-bind", cellCliBundlePath(), "/run/honeybee/hive.mjs");
  for (const home of homes) out.push("--remount-ro", home);
  out.push("--remount-ro", "/run",
    "--unsetenv", "DBUS_SESSION_BUS_ADDRESS", "--unsetenv", "DBUS_SYSTEM_BUS_ADDRESS",
    "--unsetenv", "SSH_AUTH_SOCK", "--unsetenv", "XDG_RUNTIME_DIR", "--unsetenv", "NODE_OPTIONS",
    "--setenv", "HIVE_CELL_GATEWAY_SOCKET", "/run/honeybee/gateway.sock",
    "--setenv", "PATH", `/run/honeybee/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
    "--share-net", "--die-with-parent");
  const parent = statSync("/proc/self/ns/user");
  out.push("--", "/run/honeybee/cell-scope", "--assert-userns", `${parent.dev}:${parent.ino}`, "--", command, ...args);
  return out;
}

export interface WrappedCommand {
  command: string;
  args: string[];
  /** darwin only: the profile text the caller must write to `profilePath`. */
  profile?: string;
}

/**
 * Wrap an inner spawn command with the platform sandbox. `profilePath` is
 * where the darwin Seatbelt profile file lives (the caller writes
 * `profile` there before spawning — the box dir owns it).
 */
export function wrapWithSandbox(
  policy: SandboxPolicy,
  command: string,
  args: string[],
  profilePath: string,
  osPlatform: string = platform(),
): WrappedCommand {
  if (osPlatform === "darwin") {
    if (policy.harnessHome) throw new Error("cell sandbox: private harness input projection is unsupported on darwin; refusing launch");
    return {
      command: "sandbox-exec",
      args: ["-f", profilePath, command, ...args],
      profile: seatbeltProfile(policy),
    };
  }
  if (osPlatform === "linux") {
    const socket = policy.gatewaySocketPath;
    if (!socket || !isAbsolute(socket)) throw new Error("cell sandbox: per-Cell gateway is required; refusing launch");
    const info = lstatSync(socket, { throwIfNoEntry: false });
    if (!info?.isSocket() || info.isSymbolicLink() || realpathSync(socket) !== socket) throw new Error("cell sandbox: per-Cell gateway is missing or unsafe; refusing launch");
    return { command: validatedCellScopeBinary(), args: ["--", "bwrap", ...bwrapArgs(policy, command, args)] };
  }
  throw new Error(`cell sandbox: unsupported platform '${osPlatform}'`);
}
