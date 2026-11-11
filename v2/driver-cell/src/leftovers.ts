/**
 * Agent leftovers: untracked or ignored top-level entries a Cell bee writes
 * while working (`.audit/`, `.proof/`, review scratch, tool homes) that are
 * never work the owner lands. They do not make a Cell dirty, they are left
 * out of a WIP snapshot, and eviction deletes them instead of keeping them.
 * Matching is by the first path component only, with `*` as the one glob.
 */
export const DEFAULT_LEFTOVER_PATTERNS: readonly string[] = [
  ".audit",
  ".proof",
  ".artifacts",
  ".scratch",
  ".cache",
  ".tmp",
  ".run",
  ".local",
  ".local-cache",
  ".cell-home",
  ".cell-tools",
  ".worker-home",
  ".toolchain",
  ".tools",
  ".pgdata",
  ".checker-stage",
  ".checker-*",
  ".proof-*",
  ".review",
  ".review-*",
  ".gate-*",
  ".*-evidence",
  ".*-fixture",
  "__pycache__",
  ".DS_Store",
  "*.log",
];

export function validLeftoverPattern(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "*" && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\0");
}

function patternRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${escaped}$`);
}

export function matchesLeftoverPattern(name: string, patterns: readonly string[] = DEFAULT_LEFTOVER_PATTERNS): boolean {
  return patterns.some((pattern) => (pattern.includes("*") ? patternRegExp(pattern).test(name) : pattern === name));
}

export function leftoverTopLevel(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = trimmed.indexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(0, slash);
}

export function isLeftoverPath(path: string, patterns: readonly string[] = DEFAULT_LEFTOVER_PATTERNS): boolean {
  return matchesLeftoverPattern(leftoverTopLevel(path), patterns);
}

/** Split space-relative paths into leftovers and everything else, in input order. */
export function partitionLeftovers(paths: readonly string[], patterns: readonly string[] = DEFAULT_LEFTOVER_PATTERNS): { leftovers: string[]; kept: string[] } {
  const leftovers: string[] = [];
  const kept: string[] = [];
  for (const path of paths) (isLeftoverPath(path, patterns) ? leftovers : kept).push(path);
  return { leftovers, kept };
}

/** The distinct top-level entries among `paths` that are leftovers, for pathspec exclusion. */
export function leftoverTopLevels(paths: readonly string[], patterns: readonly string[] = DEFAULT_LEFTOVER_PATTERNS): string[] {
  return [...new Set(paths.map(leftoverTopLevel).filter((top) => matchesLeftoverPattern(top, patterns)))];
}
