/**
 * Per-node daemon config (spec 04 behavior 7; Q1 resolution: json).
 *
 * One file per node: `<dataDir>/config.json`. Every value has a default and
 * the file may be absent. Unknown keys are ignored (forward compatibility);
 * malformed json or wrongly-typed values fail loudly — a half-read config is
 * worse than no config.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** How to spawn one agent CLI (keyed by the bee's `agent` field). */
export interface AgentSpecConfig {
  command: string;
  /** Base args — the harness plumbing (`-p --input-format stream-json …`). */
  args?: string[];
  /**
   * Node-wide per-agent DEFAULT args (e.g. `["--model", "opus"]`), layered
   * over `args` and under each bee's own `bees.args` at spawn (daemon
   * resolveSpawnSpec: args < defaultArgs < bee.args < resume args; a later
   * valued flag overrides an earlier one, boolean flags are idempotent).
   */
  defaultArgs?: string[];
  /** Adapter name: agy | claude | codex | grok | kimi | stub. Defaults to the agent key itself. */
  adapter?: string;
  env?: Record<string, string>;
  /**
   * v7 (spec 08): the harness's own login invocation for `account.login`'s
   * seat (default = the recipe's: bare `claude`, `codex login`, …). Tests
   * point it at a fake login that writes the recipe file.
   */
  login?: { command: string; args?: string[] };
}

export const NAMING_TOOLS = ["codex", "claude"] as const;
export type NamingTool = (typeof NAMING_TOOLS)[number];

export const NAMING_BACKENDS = ["codex-app-server", "openai-api", "claude-cli"] as const;
export type NamingBackend = (typeof NAMING_BACKENDS)[number];

export const NAMING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type NamingEffort = (typeof NAMING_EFFORTS)[number];

/** Daemon auto-titler (untitled bees → semantic `title` from the mailbox). */
export interface NamingConfig {
  /** Default true. */
  auto?: boolean;
  /** Generator transport. Default is one warm Codex app-server process. */
  backend?: NamingBackend;
  /** @deprecated Compatibility selector for configs written before `backend`. */
  tool?: NamingTool;
  /** Model passed to the generator. Default "gpt-6-luna". */
  model?: string;
  /** Reasoning effort for Codex/OpenAI. Default "none". Ignored by Claude. */
  effort?: NamingEffort;
  /** OpenAI Responses API credential. Write-only over RPC; never returned publicly. */
  apiKey?: string;
  /** Custom generator command (prompt on stdin, title on stdout). Overrides tool/model. */
  command?: string;
}

export interface ResolvedNamingConfig {
  auto: boolean;
  backend: NamingBackend;
  tool: NamingTool;
  model: string;
  effort: NamingEffort;
  apiKey?: string;
  command?: string;
  /** Dedicated cwd so title-gen sessions never pollute a bee's transcript folder. */
  generatorCwd: string;
}

export const NAMING_DEFAULTS = {
  auto: true,
  backend: "codex-app-server" as NamingBackend,
  tool: "codex" as NamingTool,
  model: "gpt-6-luna",
  effort: "none" as NamingEffort,
};

/** v7 (spec 08): accounts + vault settings. */
export interface AccountsConfig {
  /** Credential vault root (`<vault>/<harness>/<accountId>/`). Default ~/.hive/vault (the old layout, shared on purpose). */
  vaultDir?: string;
  /** Run-homes root (`<homes>/<accountId>`). Default ~/.hive/homes. */
  homesDir?: string;
  /** A limits row older than this is refreshed before an `auto` pick. Default 1h. */
  limitsStaleMs?: number;
  /** Periodic in-daemon limits refresh while running. Default 15 min; 0 disables. */
  limitsRefreshMs?: number;
  /** Per-fetch bound for a provider limits read. Default 15s. */
  limitsFetchTimeoutMs?: number;
  /**
   * tmux socket name (`tmux -L <name>`) the RETIRED login seats ran on; kept
   * only so boot can clean up legacy `hive-login-*` sessions the daemon
   * itself created. Absent = the default server.
   */
  tmuxSocket?: string;
  /** How long a login flow may stay open before it expires. Default 10 min. */
  loginTimeoutMs?: number;
  /**
   * Native login worker backend for CLI-driven methods: `auto` (node-pty when
   * installed, else pipes for CLIs that do not need a TTY), `pipe` (never load
   * node-pty; TTY-requiring methods refuse with `pty_unavailable`). Default auto.
   */
  loginWorkerBackend?: "auto" | "pipe";
  /** Rotation cool-off: an account with rate-limit exhaustion evidence younger than this is not rotated ONTO. Default 5h. */
  exhaustionCoolOffMs?: number;
  /** Automatic-account admission rollout. `shadow` records decisions but preserves legacy placement. Default shadow. */
  allocationMode?: "shadow" | "active";
  /** Stable Apiary node identity for this daemon's allocation RPCs. */
  allocationNodeId?: string;
  /** Fenced allocator identity every node trusts. Required in active mode. */
  allocationOwner?: { node: string; epoch: string };
  /** Maximum age of provider quota used for a new automatic admission. Default 2 min. */
  allocationQuotaFreshMs?: number;
  /** Maximum age of the caller's all-other-nodes activity snapshot. Default 2 min. */
  allocationActivityFreshMs?: number;
  /** Stopped/idle work counts as recently active for this long. Default 15 min. */
  allocationRecentGraceMs?: number;
  /** Abandoned start holds expire after this bound. Default 15 min. */
  allocationReservationTtlMs?: number;
  /** Comparable plan-capacity multipliers keyed by lower-case provider plan name. */
  allocationPlanCapacityUnits?: Record<string, number>;
}

/** Node kinds (core contract §1): decides the cell-sandbox default (A4). */
export type NodeKind = "workstation" | "satellite" | "cloud";

export const NODE_KINDS: readonly NodeKind[] = ["workstation", "satellite", "cloud"];

/** Cell substrate settings (WP5, spec 05) — deliberately minimal. */
export interface CellsConfig {
  /** Cells root directory. Default `<dataDir>/cells`. */
  root?: string;
  /** Node-wide sandbox override; absent = node-kind default (A4). */
  sandbox?: boolean;
  /** Per-repo warm-cell artifact dirs (A5, opt-in), keyed by origin repo path. */
  warm?: Record<string, string[]>;
  /** Test-only: allow agent `stub` on bee.move. Default false. */
  allowStubMove?: boolean;
  /**
   * Warm Cell pool: target free pre-provisioned members per repo (0 = off).
   * Defaults to 1 on satellites, where every Cell is a `git clone --local`
   * plus a full checkout, and 0 elsewhere. Overridden by env
   * HIVE_CELL_WARMPOOL_FREE. See warmPool.ts.
   */
  warmPoolFree?: number;
  /** Warm pool hard cap on members per repo (default 32). */
  warmPoolMaxSize?: number;
  /** v31 — automatic Cell disk retention. Absent = defaults (enabled). */
  retention?: CellRetentionConfig;
}

/**
 * Cell retention policy (v31). A Cell is reclaimed ("evicted": directory
 * removed, registry row + bee + transcript kept, revive re-provisions) only
 * when it is CLEAN — no uncommitted changes, no commits the origin has not
 * seen, origin reachable — and no runtime or Cell operation is using it.
 * Dirty Cells are never reclaimed automatically; `hive cell gc` lists them.
 */
export interface CellRetentionConfig {
  /** Master switch (default true). Off = no automatic pass; `hive cell gc` still works. */
  enabled?: boolean;
  /** Evict a clean Cell whose bee has been archived for at least this long (default 7). 0 = immediately. */
  archivedAfterDays?: number;
  /**
   * Evict a clean Cell whose active bee has been stopped (no runtime, no
   * output) for at least this long (default 30). null = never touch Cells of
   * active bees by age.
   */
  stoppedAfterDays?: number | null;
  /** Remove a clean `retained` Cell (its bee moved away) after this long (default 14). null = never. */
  retainedAfterDays?: number | null;
  /**
   * Total allocated bytes across Cells (du semantics) the pass tries to stay
   * under. When exceeded, additional clean Cells of archived, then stopped
   * bees are evicted oldest-idle first regardless of the age floors. null =
   * no budget (default).
   */
  maxBytes?: number | null;
  /** Hours between automatic passes (default 24). */
  intervalHours?: number;
  /** Upper bound on evictions per pass (default 100). */
  maxPerPass?: number;
}

export interface ResolvedCellRetention {
  enabled: boolean;
  archivedAfterMs: number;
  stoppedAfterMs: number | null;
  retainedAfterMs: number | null;
  maxBytes: number | null;
  intervalMs: number;
  maxPerPass: number;
}

/** The raw (all-optional) shape of config.json. */
export interface NodeConfigFile {
  /** Node kind (workstation | satellite | cloud). Default workstation. */
  nodeKind?: NodeKind;
  /** Cell substrate settings (WP5). */
  cells?: CellsConfig;
  /** Scale-to-zero idle window (behavior 3). Default 60 min; 0/negative disables. */
  idleWindowMs?: number;
  /** Hang policy: stop a runtime stuck in `booting` past this. */
  bootHangTimeoutMs?: number;
  /**
   * @deprecated Ignored. Running turns are unbounded; silence and elapsed
   * time are not failure evidence. Retained only so old config files remain
   * readable during the compatibility window.
   */
  turnHangTimeoutMs?: number;
  /** I1 deadline allowance for a replacement runtime to boot. */
  bootAllowanceMs?: number;
  /** I1 deadline allowance for a preceding turn to finish. */
  turnAllowanceMs?: number;
  /**
   * I1 delivery deadline per pending mailbox position (behavior 5). Clamped
   * UP to the policy-aware floor: boot timeout + boot + ordinary-turn
   * allowances. A breach records telemetry; it never stops a running turn.
   */
  i1DeadlineMs?: number;
  /** Daemon tick interval. */
  tickMs?: number;
  /** Executor budget per tick. */
  commandsPerTick?: number;
  /** B5 retry table. */
  retry?: { maxAttempts?: number; backoffBaseMs?: number };
  /** TERM→KILL escalation grace for stops. */
  stopKillGraceMs?: number;
  /** Start-time tolerance for cross-restart re-adoption. */
  adoptToleranceMs?: number;
  /** Watch stream: max delta events per frame before the server declares a gap. */
  watchMaxBatch?: number;
  socketPath?: string;
  logPath?: string;
  storePath?: string;
  telemetryPath?: string;
  sessionLogDir?: string;
  agents?: Record<string, AgentSpecConfig>;
  /** v7 (spec 08). */
  accounts?: AccountsConfig;
  /** Auto-titler. Default on, warm Codex app-server with GPT-6 Luna at no reasoning. */
  naming?: NamingConfig;
}

export interface ResolvedNodeConfig {
  dataDir: string;
  configPath: string;
  nodeKind: NodeKind;
  cellsRoot: string;
  /** Node-wide cell-sandbox override; null = node-kind default (A4). */
  cellSandbox: boolean | null;
  /** Per-repo warm-cell artifact dirs (A5). */
  cellWarm: Record<string, string[]>;
  /** Test-only stub continuation for bee.move. */
  cellMoveAllowStub: boolean;
  /** Warm Cell pool: target free members per repo (0 = off). */
  cellWarmPoolFree: number;
  /** Warm Cell pool: hard cap on members per repo. */
  cellWarmPoolMaxSize: number;
  /** v31 — Cell disk retention policy. */
  cellRetention: ResolvedCellRetention;
  idleWindowMs: number;
  bootHangTimeoutMs: number;
  bootAllowanceMs: number;
  turnAllowanceMs: number;
  /** The effective (floor-clamped) I1 deadline. */
  i1DeadlineMs: number;
  /** The policy-aware floor the deadline was clamped to. */
  i1FloorMs: number;
  tickMs: number;
  commandsPerTick: number;
  maxAttempts: number;
  backoffBaseMs: number;
  stopKillGraceMs: number;
  adoptToleranceMs: number;
  watchMaxBatch: number;
  socketPath: string;
  logPath: string;
  storePath: string;
  telemetryPath: string;
  sessionLogDir: string;
  agents: Record<string, AgentSpecConfig>;
  /** v7 (spec 08): resolved accounts settings (every field defaulted). */
  accounts: Required<Omit<AccountsConfig, "tmuxSocket" | "allocationNodeId" | "allocationOwner">> & {
    tmuxSocket: string | null;
    allocationNodeId: string | null;
    allocationOwner: { node: string; epoch: string } | null;
  };
  naming: ResolvedNamingConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Built-in agent table; a config `agents` entry with the same key overrides it wholesale. */
export const BUILTIN_AGENTS: Record<string, AgentSpecConfig> = {
  kimi: { command: "kimi", args: ["acp"], adapter: "kimi" },
  agy: {
    command: "agy",
    args: [
      "--print=",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout", "12h",
    ],
    adapter: "agy",
    env: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
  },
  claude: {
    command: "claude",
    args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    adapter: "claude",
  },
  codex: {
    command: "codex",
    args: ["app-server"],
    adapter: "codex",
  },
  grok: {
    command: "grok",
    args: ["--no-auto-update", "agent", "--no-leader", "--always-approve", "stdio"],
    adapter: "grok",
  },
};

export const DEFAULTS = {
  idleWindowMs: 60 * 60 * 1000, // Q4 ruling: default 60 min
  bootHangTimeoutMs: 3 * 60 * 1000,
  bootAllowanceMs: 60 * 1000,
  turnAllowanceMs: 5 * 60 * 1000,
  tickMs: 200,
  commandsPerTick: 8,
  maxAttempts: 5,
  backoffBaseMs: 30_000,
  stopKillGraceMs: 5000,
  adoptToleranceMs: 5000,
  watchMaxBatch: 256,
  limitsStaleMs: 60 * 60 * 1000,
  limitsRefreshMs: 15 * 60 * 1000,
  limitsFetchTimeoutMs: 15_000,
  loginTimeoutMs: 10 * 60 * 1000,
  exhaustionCoolOffMs: 5 * 60 * 60 * 1000,
  allocationMode: "shadow" as const,
  allocationQuotaFreshMs: 2 * 60 * 1000,
  allocationActivityFreshMs: 2 * 60 * 1000,
  allocationRecentGraceMs: 15 * 60 * 1000,
  allocationReservationTtlMs: 15 * 60 * 1000,
} as const;

/** Default per-node data directory; overridable via HIVE_V2_DATA_DIR (tests always set it). */
export function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
  return env.HIVE_V2_DATA_DIR ?? join(homedir(), ".hive", "v2");
}

function num(raw: Record<string, unknown>, key: string, fallback: number): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`config: ${key} must be a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function str(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || v.length === 0) {
    throw new ConfigError(`config: ${key} must be a non-empty string`);
  }
  return v;
}

function nodeKindOf(raw: Record<string, unknown>): NodeKind {
  const v = raw.nodeKind;
  if (v === undefined) return "workstation";
  if (typeof v !== "string" || !(NODE_KINDS as readonly string[]).includes(v)) {
    throw new ConfigError(`config: nodeKind must be one of ${NODE_KINDS.join("|")}, got ${JSON.stringify(v)}`);
  }
  return v as NodeKind;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_CELL_RETENTION: ResolvedCellRetention = {
  enabled: true,
  archivedAfterMs: 7 * DAY_MS,
  stoppedAfterMs: 30 * DAY_MS,
  retainedAfterMs: 14 * DAY_MS,
  maxBytes: null,
  intervalMs: 24 * HOUR_MS,
  maxPerPass: 100,
};

function nonNegativeNumber(c: Record<string, unknown>, key: string): number | undefined {
  const v = c[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ConfigError(`config: cells.retention.${key} must be a non-negative number`);
  }
  return v;
}

function nullableNonNegativeNumber(c: Record<string, unknown>, key: string): number | null | undefined {
  if (c[key] === null) return null;
  return nonNegativeNumber(c, key);
}

export function cellRetentionOf(raw: unknown): ResolvedCellRetention {
  if (raw === undefined) return { ...DEFAULT_CELL_RETENTION };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config: cells.retention must be an object");
  }
  const c = raw as Record<string, unknown>;
  const out: ResolvedCellRetention = { ...DEFAULT_CELL_RETENTION };
  if (c.enabled !== undefined) {
    if (typeof c.enabled !== "boolean") throw new ConfigError("config: cells.retention.enabled must be a boolean");
    out.enabled = c.enabled;
  }
  const archived = nonNegativeNumber(c, "archivedAfterDays");
  if (archived !== undefined) out.archivedAfterMs = archived * DAY_MS;
  const stopped = nullableNonNegativeNumber(c, "stoppedAfterDays");
  if (stopped !== undefined) out.stoppedAfterMs = stopped === null ? null : stopped * DAY_MS;
  const retained = nullableNonNegativeNumber(c, "retainedAfterDays");
  if (retained !== undefined) out.retainedAfterMs = retained === null ? null : retained * DAY_MS;
  const maxBytes = nullableNonNegativeNumber(c, "maxBytes");
  if (maxBytes !== undefined) out.maxBytes = maxBytes;
  const interval = nonNegativeNumber(c, "intervalHours");
  if (interval !== undefined) {
    if (interval <= 0) throw new ConfigError("config: cells.retention.intervalHours must be positive");
    out.intervalMs = interval * HOUR_MS;
  }
  if (c.maxPerPass !== undefined) {
    if (typeof c.maxPerPass !== "number" || !Number.isInteger(c.maxPerPass) || c.maxPerPass < 1) {
      throw new ConfigError("config: cells.retention.maxPerPass must be a positive integer");
    }
    out.maxPerPass = c.maxPerPass;
  }
  return out;
}

function cellsOf(raw: Record<string, unknown>, nodeKind: NodeKind): { root?: string; sandbox: boolean | null; warm: Record<string, string[]>; allowStubMove: boolean; warmPoolFree: number; warmPoolMaxSize: number; retention: ResolvedCellRetention } {
  const envFree = Number(process.env.HIVE_CELL_WARMPOOL_FREE);
  const envOverride = Number.isFinite(envFree) && envFree >= 0 ? Math.floor(envFree) : null;
  const defaultWarmPoolFree = nodeKind === "satellite" ? 1 : 0;
  const v = raw.cells;
  if (v === undefined) return { sandbox: null, warm: {}, allowStubMove: false, warmPoolFree: envOverride ?? defaultWarmPoolFree, warmPoolMaxSize: 32, retention: cellRetentionOf(undefined) };
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ConfigError("config: cells must be an object of {root?, sandbox?, warm?, retention?}");
  }
  const c = v as Record<string, unknown>;
  const out: { root?: string; sandbox: boolean | null; warm: Record<string, string[]>; allowStubMove: boolean; warmPoolFree: number; warmPoolMaxSize: number; retention: ResolvedCellRetention } = {
    sandbox: null,
    warm: {},
    allowStubMove: false,
    warmPoolFree: defaultWarmPoolFree,
    warmPoolMaxSize: 32,
    retention: cellRetentionOf(c.retention),
  };
  if (c.warmPoolFree !== undefined) {
    if (typeof c.warmPoolFree !== "number" || !Number.isInteger(c.warmPoolFree) || c.warmPoolFree < 0) {
      throw new ConfigError("config: cells.warmPoolFree must be a non-negative integer");
    }
    out.warmPoolFree = c.warmPoolFree;
  }
  if (c.warmPoolMaxSize !== undefined) {
    if (typeof c.warmPoolMaxSize !== "number" || !Number.isInteger(c.warmPoolMaxSize) || c.warmPoolMaxSize < 1) {
      throw new ConfigError("config: cells.warmPoolMaxSize must be a positive integer");
    }
    out.warmPoolMaxSize = c.warmPoolMaxSize;
  }
  if (envOverride !== null) out.warmPoolFree = envOverride;
  if (c.root !== undefined) {
    if (typeof c.root !== "string" || c.root.length === 0) {
      throw new ConfigError("config: cells.root must be a non-empty string");
    }
    out.root = c.root;
  }
  if (c.sandbox !== undefined) {
    if (typeof c.sandbox !== "boolean") throw new ConfigError("config: cells.sandbox must be a boolean");
    out.sandbox = c.sandbox;
  }
  if (c.warm !== undefined) {
    if (c.warm === null || typeof c.warm !== "object" || Array.isArray(c.warm)) {
      throw new ConfigError("config: cells.warm must be an object of {repoPath: [artifactDirs]}");
    }
    for (const [repo, dirs] of Object.entries(c.warm as Record<string, unknown>)) {
      if (!Array.isArray(dirs) || dirs.some((d) => typeof d !== "string" || d.length === 0)) {
        throw new ConfigError(`config: cells.warm['${repo}'] must be an array of non-empty strings`);
      }
      out.warm[repo] = dirs as string[];
    }
  }
  if (c.allowStubMove !== undefined) {
    if (typeof c.allowStubMove !== "boolean") throw new ConfigError("config: cells.allowStubMove must be a boolean");
    out.allowStubMove = c.allowStubMove;
  }
  return out;
}

function agentsOf(raw: Record<string, unknown>): Record<string, AgentSpecConfig> {
  const v = raw.agents;
  if (v === undefined) return {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ConfigError("config: agents must be an object of {command, args?, adapter?, env?}");
  }
  const out: Record<string, AgentSpecConfig> = {};
  for (const [name, spec] of Object.entries(v as Record<string, unknown>)) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      throw new ConfigError(`config: agents.${name} must be an object`);
    }
    const s = spec as Record<string, unknown>;
    if (typeof s.command !== "string" || s.command.length === 0) {
      throw new ConfigError(`config: agents.${name}.command must be a non-empty string`);
    }
    const entry: AgentSpecConfig = { command: s.command };
    if (s.args !== undefined) {
      if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string")) {
        throw new ConfigError(`config: agents.${name}.args must be a string array`);
      }
      entry.args = s.args as string[];
    }
    if (s.defaultArgs !== undefined) {
      if (!Array.isArray(s.defaultArgs) || s.defaultArgs.some((a) => typeof a !== "string")) {
        throw new ConfigError(`config: agents.${name}.defaultArgs must be a string array`);
      }
      entry.defaultArgs = s.defaultArgs as string[];
    }
    if (s.adapter !== undefined) {
      if (typeof s.adapter !== "string") throw new ConfigError(`config: agents.${name}.adapter must be a string`);
      entry.adapter = s.adapter;
    }
    if (s.env !== undefined) {
      if (s.env === null || typeof s.env !== "object" || Array.isArray(s.env)) {
        throw new ConfigError(`config: agents.${name}.env must be an object of strings`);
      }
      for (const val of Object.values(s.env as Record<string, unknown>)) {
        if (typeof val !== "string") throw new ConfigError(`config: agents.${name}.env values must be strings`);
      }
      entry.env = s.env as Record<string, string>;
    }
    if (s.login !== undefined) {
      const l = s.login as Record<string, unknown> | null;
      if (l === null || typeof l !== "object" || Array.isArray(l) || typeof l.command !== "string" || l.command.length === 0) {
        throw new ConfigError(`config: agents.${name}.login must be an object {command, args?}`);
      }
      if (l.args !== undefined && (!Array.isArray(l.args) || l.args.some((a) => typeof a !== "string"))) {
        throw new ConfigError(`config: agents.${name}.login.args must be a string array`);
      }
      entry.login = { command: l.command, ...(l.args !== undefined ? { args: l.args as string[] } : {}) };
    }
    out[name] = entry;
  }
  return out;
}

export function namingOf(raw: Record<string, unknown>, dataDir: string): ResolvedNamingConfig {
  const v = raw.naming;
  if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) {
    throw new ConfigError("config: naming must be an object");
  }
  const n = (v ?? {}) as Record<string, unknown>;
  if (n.auto !== undefined && typeof n.auto !== "boolean") {
    throw new ConfigError("config: naming.auto must be a boolean");
  }
  if (n.backend !== undefined && !(NAMING_BACKENDS as readonly unknown[]).includes(n.backend)) {
    throw new ConfigError(`config: naming.backend must be one of ${NAMING_BACKENDS.join("|")}`);
  }
  if (n.tool !== undefined && (n.tool !== "codex" && n.tool !== "claude")) {
    throw new ConfigError('config: naming.tool must be "codex" or "claude"');
  }
  if (n.model !== undefined && (typeof n.model !== "string" || n.model.length === 0)) {
    throw new ConfigError("config: naming.model must be a non-empty string");
  }
  if (n.effort !== undefined && (typeof n.effort !== "string" || !(NAMING_EFFORTS as readonly string[]).includes(n.effort))) {
    throw new ConfigError(`config: naming.effort must be one of ${NAMING_EFFORTS.join("|")}`);
  }
  if (n.apiKey !== undefined && (typeof n.apiKey !== "string" || n.apiKey.length === 0)) {
    throw new ConfigError("config: naming.apiKey must be a non-empty string when given");
  }
  if (n.command !== undefined && (typeof n.command !== "string" || n.command.length === 0)) {
    throw new ConfigError("config: naming.command must be a non-empty string when given");
  }
  const backend = (n.backend as NamingBackend | undefined) ??
    (n.tool === "claude" ? "claude-cli" : NAMING_DEFAULTS.backend);
  if (backend === "openai-api" && typeof n.apiKey !== "string") {
    throw new ConfigError("config: naming.apiKey is required when naming.backend is openai-api");
  }
  const tool: NamingTool = backend === "claude-cli" ? "claude" : "codex";
  return {
    auto: n.auto !== false,
    backend,
    tool,
    model: (n.model as string | undefined) ?? NAMING_DEFAULTS.model,
    effort: (n.effort as NamingEffort | undefined) ?? NAMING_DEFAULTS.effort,
    ...(typeof n.apiKey === "string" ? { apiKey: n.apiKey } : {}),
    ...(typeof n.command === "string" ? { command: n.command } : {}),
    generatorCwd: join(dataDir, "naming"),
  };
}

export function publicNamingConfig(naming: ResolvedNamingConfig): {
  auto: boolean;
  backend: NamingBackend;
  tool: NamingTool;
  model: string;
  effort: NamingEffort;
  apiKeyConfigured: boolean;
  command?: string;
} {
  return {
    auto: naming.auto,
    backend: naming.backend,
    tool: naming.tool,
    model: naming.model,
    effort: naming.effort,
    apiKeyConfigured: Boolean(naming.apiKey),
    ...(naming.command ? { command: naming.command } : {}),
  };
}

/**
 * Merge a naming patch into config.json and return the resolved naming.
 * Unknown top-level keys in the existing file are preserved.
 */
export function patchNamingConfig(configPath: string, dataDir: string, patch: NamingConfig): ResolvedNamingConfig {
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new ConfigError(`config: ${configPath} is not valid json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`config: ${configPath} must contain a json object`);
    }
    raw = parsed as Record<string, unknown>;
  }
  const current = (raw.naming && typeof raw.naming === "object" && !Array.isArray(raw.naming)
    ? (raw.naming as Record<string, unknown>)
    : {}) as NamingConfig;
  const next: NamingConfig = { ...current };
  if (patch.auto !== undefined) next.auto = patch.auto;
  if (patch.backend !== undefined) next.backend = patch.backend;
  if (patch.tool !== undefined) next.tool = patch.tool;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.effort !== undefined) next.effort = patch.effort;
  if (patch.apiKey !== undefined) {
    if (patch.apiKey.length === 0) delete next.apiKey;
    else next.apiKey = patch.apiKey;
  }
  if (patch.command !== undefined) {
    if (patch.command.length === 0) delete next.command;
    else next.command = patch.command;
  }
  raw.naming = next;
  const resolved = namingOf(raw, dataDir);
  const tmp = `${configPath}.${process.pid}.tmp`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
  return resolved;
}

function accountsOf(raw: Record<string, unknown>): ResolvedNodeConfig["accounts"] {
  const v = raw.accounts;
  if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) {
    throw new ConfigError("config: accounts must be an object");
  }
  const a = (v ?? {}) as Record<string, unknown>;
  const socket = a.tmuxSocket;
  if (socket !== undefined && (typeof socket !== "string" || socket.length === 0)) {
    throw new ConfigError("config: accounts.tmuxSocket must be a non-empty string when given");
  }
  const backend = a.loginWorkerBackend === undefined ? "auto" : a.loginWorkerBackend;
  if (backend !== "auto" && backend !== "pipe") {
    throw new ConfigError("config: accounts.loginWorkerBackend must be 'auto' or 'pipe' when given");
  }
  const allocationMode = a.allocationMode === undefined ? DEFAULTS.allocationMode : a.allocationMode;
  if (allocationMode !== "shadow" && allocationMode !== "active") {
    throw new ConfigError("config: accounts.allocationMode must be 'shadow' or 'active'");
  }
  const allocationNodeId = a.allocationNodeId === undefined ? null : a.allocationNodeId;
  if (allocationNodeId !== null && (typeof allocationNodeId !== "string" || allocationNodeId.length === 0 || allocationNodeId.length > 128)) {
    throw new ConfigError("config: accounts.allocationNodeId must be a non-empty string of at most 128 characters");
  }
  const rawOwner = a.allocationOwner;
  if (rawOwner !== undefined && (rawOwner === null || typeof rawOwner !== "object" || Array.isArray(rawOwner))) {
    throw new ConfigError("config: accounts.allocationOwner must be {node,epoch}");
  }
  const ownerObject = rawOwner as Record<string, unknown> | undefined;
  const allocationOwner = ownerObject === undefined ? null : {
    node: ownerObject.node,
    epoch: ownerObject.epoch,
  };
  if (allocationOwner !== null
    && (typeof allocationOwner.node !== "string" || allocationOwner.node.length === 0 || allocationOwner.node.length > 128
      || typeof allocationOwner.epoch !== "string" || allocationOwner.epoch.length === 0 || allocationOwner.epoch.length > 128
      || Object.keys(ownerObject!).some((key) => key !== "node" && key !== "epoch"))) {
    throw new ConfigError("config: accounts.allocationOwner must be bounded non-empty {node,epoch}");
  }
  if (allocationMode === "active" && (allocationNodeId === null || allocationOwner === null)) {
    throw new ConfigError("config: active account allocation requires accounts.allocationNodeId and accounts.allocationOwner {node,epoch}");
  }
  const rawCapacity = a.allocationPlanCapacityUnits;
  if (rawCapacity !== undefined && (rawCapacity === null || typeof rawCapacity !== "object" || Array.isArray(rawCapacity))) {
    throw new ConfigError("config: accounts.allocationPlanCapacityUnits must be an object of positive finite numbers");
  }
  const allocationPlanCapacityUnits: Record<string, number> = {};
  for (const [plan, units] of Object.entries((rawCapacity ?? {}) as Record<string, unknown>)) {
    if (!plan.trim() || typeof units !== "number" || !Number.isFinite(units) || units <= 0) {
      throw new ConfigError("config: accounts.allocationPlanCapacityUnits must be an object of positive finite numbers");
    }
    allocationPlanCapacityUnits[plan.toLowerCase()] = units;
  }
  const allocationQuotaFreshMs = num(a, "allocationQuotaFreshMs", DEFAULTS.allocationQuotaFreshMs);
  const allocationActivityFreshMs = num(a, "allocationActivityFreshMs", DEFAULTS.allocationActivityFreshMs);
  const allocationRecentGraceMs = num(a, "allocationRecentGraceMs", DEFAULTS.allocationRecentGraceMs);
  const allocationReservationTtlMs = num(a, "allocationReservationTtlMs", DEFAULTS.allocationReservationTtlMs);
  if (allocationQuotaFreshMs <= 0 || allocationActivityFreshMs <= 0 || allocationRecentGraceMs < 0 || allocationReservationTtlMs <= 0) {
    throw new ConfigError("config: allocation freshness/TTL must be positive and recent grace must be non-negative");
  }
  return {
    vaultDir: str(a, "vaultDir", join(homedir(), ".hive", "vault")),
    homesDir: str(a, "homesDir", join(homedir(), ".hive", "homes")),
    limitsStaleMs: num(a, "limitsStaleMs", DEFAULTS.limitsStaleMs),
    limitsRefreshMs: num(a, "limitsRefreshMs", DEFAULTS.limitsRefreshMs),
    limitsFetchTimeoutMs: num(a, "limitsFetchTimeoutMs", DEFAULTS.limitsFetchTimeoutMs),
    loginTimeoutMs: num(a, "loginTimeoutMs", DEFAULTS.loginTimeoutMs),
    exhaustionCoolOffMs: num(a, "exhaustionCoolOffMs", DEFAULTS.exhaustionCoolOffMs),
    allocationMode,
    allocationNodeId: allocationNodeId as string | null,
    allocationOwner: allocationOwner as { node: string; epoch: string } | null,
    allocationQuotaFreshMs,
    allocationActivityFreshMs,
    allocationRecentGraceMs,
    allocationReservationTtlMs,
    allocationPlanCapacityUnits,
    tmuxSocket: (socket as string | undefined) ?? null,
    loginWorkerBackend: backend,
  };
}

/**
 * Load and resolve the node config. `configPath` defaults to
 * `<dataDir>/config.json`; an absent file resolves to pure defaults.
 */
export function loadNodeConfig(dataDir: string, configPath?: string): ResolvedNodeConfig {
  const path = configPath ?? join(dataDir, "config.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new ConfigError(`config: ${path} is not valid json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`config: ${path} must contain a json object`);
    }
    raw = parsed as Record<string, unknown>;
  }
  const retryRaw =
    raw.retry === undefined
      ? {}
      : (() => {
          if (raw.retry === null || typeof raw.retry !== "object" || Array.isArray(raw.retry)) {
            throw new ConfigError("config: retry must be an object");
          }
          return raw.retry as Record<string, unknown>;
        })();

  const bootHangTimeoutMs = num(raw, "bootHangTimeoutMs", DEFAULTS.bootHangTimeoutMs);
  const bootAllowanceMs = num(raw, "bootAllowanceMs", DEFAULTS.bootAllowanceMs);
  const turnAllowanceMs = num(raw, "turnAllowanceMs", DEFAULTS.turnAllowanceMs);
  // Behavior 5: the deadline covers bounded system recovery plus ordinary
  // boot/turn allowances. It is observability, never a destructive watchdog:
  // a legitimate long-running turn may exceed it without being stopped.
  const i1FloorMs = bootHangTimeoutMs + bootAllowanceMs + turnAllowanceMs;
  const i1DeadlineMs = Math.max(num(raw, "i1DeadlineMs", i1FloorMs), i1FloorMs);

  const nodeKind = nodeKindOf(raw);
  const cells = cellsOf(raw, nodeKind);
  return {
    dataDir,
    configPath: path,
    nodeKind,
    cellsRoot: cells.root ?? join(dataDir, "cells"),
    cellSandbox: cells.sandbox,
    cellWarm: cells.warm,
    cellMoveAllowStub: cells.allowStubMove,
    cellWarmPoolFree: cells.warmPoolFree,
    cellWarmPoolMaxSize: cells.warmPoolMaxSize,
    cellRetention: cells.retention,
    idleWindowMs: num(raw, "idleWindowMs", DEFAULTS.idleWindowMs),
    bootHangTimeoutMs,
    bootAllowanceMs,
    turnAllowanceMs,
    i1DeadlineMs,
    i1FloorMs,
    tickMs: num(raw, "tickMs", DEFAULTS.tickMs),
    commandsPerTick: num(raw, "commandsPerTick", DEFAULTS.commandsPerTick),
    maxAttempts: num(retryRaw, "maxAttempts", DEFAULTS.maxAttempts),
    backoffBaseMs: num(retryRaw, "backoffBaseMs", DEFAULTS.backoffBaseMs),
    stopKillGraceMs: num(raw, "stopKillGraceMs", DEFAULTS.stopKillGraceMs),
    adoptToleranceMs: num(raw, "adoptToleranceMs", DEFAULTS.adoptToleranceMs),
    watchMaxBatch: num(raw, "watchMaxBatch", DEFAULTS.watchMaxBatch),
    socketPath: str(raw, "socketPath", join(dataDir, "hived.sock")),
    logPath: str(raw, "logPath", join(dataDir, "hived.log")),
    storePath: str(raw, "storePath", join(dataDir, "core.sqlite3")),
    telemetryPath: str(raw, "telemetryPath", join(dataDir, "telemetry.sqlite3")),
    sessionLogDir: str(raw, "sessionLogDir", join(dataDir, "session-logs")),
    agents: { ...BUILTIN_AGENTS, ...agentsOf(raw) },
    accounts: accountsOf(raw),
    naming: namingOf(raw, dataDir),
  };
}
