import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDaemonTarget } from "./target.ts";
import { ReadOnlyStore } from "./readonly.ts";
import { GROUPS } from "./help.ts";
import { KNOWN_FLAGS } from "./main.ts";

const GLOBAL_FLAGS = ["--data-dir", "--socket", "--config", "--json", "--allow-foreign-daemon"];
const ALIASES: Record<string, string[]> = { list: ["ls", "ps"], transcript: ["tx"], usage: ["limits"] };

function firstToken(syntax: string): string {
  return syntax.trim().split(/\s+/)[0] ?? "";
}

/** Command names, per-command subcommands and bee-first commands, read from the help table so completion cannot drift from it. */
const COMMAND_NAMES: string[] = [];
const SUBCOMMANDS: Record<string, string[]> = {};
const BEE_FIRST_ARG = new Set<string>();
for (const group of GROUPS) {
  for (const [name, syntax] of group.rows) {
    for (const alias of [name, ...(ALIASES[name] ?? [])]) if (!COMMAND_NAMES.includes(alias)) COMMAND_NAMES.push(alias);
    const head = firstToken(syntax);
    if (head.startsWith("<bee>")) BEE_FIRST_ARG.add(name);
    else if (/^[a-z][a-z0-9-]*(\|[a-z][a-z0-9-]*)*$/.test(head)) {
      const subs = (SUBCOMMANDS[name] ??= []);
      for (const sub of head.split("|")) if (!subs.includes(sub)) subs.push(sub);
      const second = syntax.trim().split(/\s+/)[1] ?? "";
      if (second.startsWith("<bee>")) for (const sub of head.split("|")) BEE_FIRST_ARG.add(`${name} ${sub}`);
    }
  }
}
for (const [name, aliases] of Object.entries(ALIASES)) for (const alias of aliases) { if (SUBCOMMANDS[name]) SUBCOMMANDS[alias] = SUBCOMMANDS[name]; if (BEE_FIRST_ARG.has(name)) BEE_FIRST_ARG.add(alias); }
for (const name of ["deploy", "completion", "help"]) if (!COMMAND_NAMES.includes(name)) COMMAND_NAMES.push(name);
COMMAND_NAMES.sort();
const COMMAND_FLAGS = [...KNOWN_FLAGS].sort();

export const SHELLS = ["bash", "zsh", "fish"];
const DEPLOY_FLAGS = ["--rollback", "--list", "--init", "--json", "--keep", "--skip-tests", "--allow-non-descendant", "--provision-question-withdrawal", "--help"];

export type CompletionState = { bees: Array<{ id: string; handle: string | null; name: string; human_ref?: string | null }> };

/** Bee references a shell can offer: handles, human refs, names and ids of active bees, read straight from the store. */
function liveState(): CompletionState {
  try {
    const target = resolveDaemonTarget({});
    const store = new ReadOnlyStore(target.cfg.storePath);
    try {
      return { bees: store.listBees().filter((row) => row.lifecycle !== "deleted").map((row) => ({ id: row.id, handle: row.handle, name: row.name, human_ref: row.human_ref })) };
    } finally { store.close(); }
  } catch { return { bees: [] }; }
}

export function beeCandidates(state: CompletionState): string[] {
  const out = new Set<string>();
  for (const bee of state.bees) {
    if (bee.human_ref) out.add(bee.human_ref);
    if (bee.handle) out.add(bee.handle);
    out.add(bee.name);
    out.add(bee.id);
  }
  return [...out];
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function fileCandidates(prefix: string, cwd: string): string[] {
  const expanded = expandTilde(prefix);
  const slash = expanded.lastIndexOf("/");
  const dir = slash === -1 ? cwd : resolve(cwd, expanded.slice(0, slash + 1));
  const stem = slash === -1 ? expanded : expanded.slice(slash + 1);
  const base = slash === -1 ? "" : prefix.slice(0, prefix.length - stem.length);
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.filter((name) => name.startsWith(stem)).map((name) => {
    let isDir = false;
    try { isDir = statSync(join(dir, name)).isDirectory(); } catch {}
    return `${base}${name}${isDir ? "/" : ""}`;
  }).sort();
}

function stripBinary(words: string[]): string[] {
  const first = words[0] ?? "";
  return first === "hive" || first.endsWith("/hive") || first.endsWith("cli.js") || first === "ap" ? words.slice(1) : words;
}

const VALUE_FLAG_KINDS: Record<string, "bee" | "file" | "shell"> = {
  "--bee": "bee", "--cwd": "file", "--file": "file", "--from": "file", "--out": "file", "--dir": "file", "--artifact": "file", "--identity": "file", "--admission": "file", "--bin-dir": "file", "--data-dir": "file", "--socket": "file", "--config": "file",
};

export function getCompletionsFromState(words: string[], state: CompletionState, cwd = process.cwd()): string[] {
  const args = stripBinary(words);
  if (args.length <= 1) {
    const cur = args[0] ?? "";
    return cur.startsWith("-") ? GLOBAL_FLAGS : COMMAND_NAMES;
  }
  const command = args[0]!;
  const current = args[args.length - 1] ?? "";
  const previous = args[args.length - 2] ?? "";
  const valueKind = VALUE_FLAG_KINDS[previous];
  if (valueKind === "bee") return beeCandidates(state);
  if (valueKind === "file") return fileCandidates(current, cwd);
  if (current.startsWith("-")) return command === "deploy" ? DEPLOY_FLAGS : COMMAND_FLAGS;
  if (command === "completion") return args.length === 2 ? SHELLS : [];
  if (command === "deploy") return [];
  const subs = SUBCOMMANDS[command];
  const positionals = args.slice(1).filter((word, index, all) => !word.startsWith("-") && !(index > 0 && all[index - 1]!.startsWith("--") && VALUE_FLAG_KINDS[all[index - 1]!]));
  if (subs && positionals.length <= 1) return subs;
  if (BEE_FIRST_ARG.has(command) && positionals.length <= 1) return beeCandidates(state);
  if (subs && BEE_FIRST_ARG.has(`${command} ${positionals[0]}`) && positionals.length <= 2) return beeCandidates(state);
  return [];
}

export function getCompletions(words: string[]): string[] {
  const needsBees = words.length >= 2;
  return getCompletionsFromState(words, needsBees ? liveState() : { bees: [] });
}
