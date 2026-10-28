import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const SANDBOX_HARNESS_INPUTS: Readonly<Record<string, readonly { path: string; why: string }[]>> = {
  codex: [
    { path: "auth.json", why: "Existing account authentication, read only" },
    { path: "config.toml", why: "Authoritative account model and MCP configuration" },
    { path: "AGENTS.md", why: "Authoritative account instructions" },
    { path: "skills", why: "Existing account skills, individual files only" },
    { path: "prompts", why: "Existing account prompts, individual files only" },
    { path: ".codex/auth.json", why: "Existing legacy authentication mirror, read only" },
  ],
  claude: [
    { path: ".credentials.json", why: "Existing account authentication, read only" },
    { path: ".claude.json", why: "Authoritative account trust and MCP configuration" },
    { path: "settings.json", why: "Authoritative account configuration" },
    { path: "CLAUDE.md", why: "Authoritative account instructions" },
    { path: "skills", why: "Existing account skills, individual files only" },
    { path: "commands", why: "Existing account commands, individual files only" },
    { path: "agents", why: "Existing account agents, individual files only" },
  ],
};

export interface SandboxHarnessProjection {
  home: string;
  sourceHome: string;
  files: readonly { source: string; destination: string }[];
}

function privateDirectory(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`cell sandbox: unsafe private harness directory: ${path}`);
  if (!info) mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

export function privateHarnessHomePath(cellDir: string, harness: string): string {
  if (!(harness in SANDBOX_HARNESS_INPUTS)) throw new Error(`cell sandbox: unsupported private harness: ${harness}`);
  return join(cellDir, "sandbox-state", harness);
}

export function prepareSandboxHarnessHome(cellDir: string, harness: string, sourceHome: string): SandboxHarnessProjection {
  if (!isAbsolute(sourceHome)) throw new Error("cell sandbox: account home must be absolute");
  const root = realpathSync(sourceHome);
  const rel = relative(root, realpathSync(cellDir));
  if (rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new Error("cell sandbox: account home contains the Cell");
  const rootInfo = lstatSync(sourceHome);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("cell sandbox: account home must be a real directory");
  privateDirectory(join(cellDir, "sandbox-state"));
  const home = privateHarnessHomePath(cellDir, harness);
  privateDirectory(home);
  const files: { source: string; destination: string }[] = [];
  const walk = (relativePath: string, depth: number): void => {
    if (depth > 16 || files.length >= 4096) throw new Error("cell sandbox: account input projection exceeds its limit");
    const source = join(root, relativePath), destination = join(home, relativePath);
    const info = lstatSync(source, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`cell sandbox: symlink account input refused: ${source}`);
    const existing = lstatSync(destination, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) throw new Error(`cell sandbox: symlink private input refused: ${destination}`);
    if (info.isDirectory()) {
      privateDirectory(destination);
      for (const entry of readdirSync(source).sort()) walk(join(relativePath, entry), depth + 1);
    } else if (info.isFile()) {
      if (existing && !existing.isFile()) throw new Error(`cell sandbox: private input type mismatch: ${destination}`);
      files.push({ source, destination });
    } else throw new Error(`cell sandbox: non-file account input refused: ${source}`);
  };
  for (const input of SANDBOX_HARNESS_INPUTS[harness] ?? []) {
    const parts = input.path.split("/");
    for (let length = 1; length < parts.length; length++) {
      const path = join(root, ...parts.slice(0, length));
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`cell sandbox: unsafe account input ancestor: ${path}`);
      privateDirectory(join(home, ...parts.slice(0, length)));
    }
    walk(input.path, 0);
  }
  return { home, sourceHome: root, files };
}
