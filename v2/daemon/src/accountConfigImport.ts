/**
 * Configuration-only account onboarding. The service reads the machine's
 * resolved vendor home and writes only recipe-allowlisted non-auth config to
 * an existing account home. It runs only for explicit preview/import RPCs.
 */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml, type TomlTable, type TomlValue } from "smol-toml";
import {
  accountConfigImportRecipeFor,
  resolveVendorHome,
  type AccountConfigImportEntryRecipe,
  type AccountRow,
} from "../../core/src/index.ts";

export type AccountConfigImportEntry = {
  path: string;
  kind: "file" | "directory";
  status: "ready" | "skipped";
  reason?: string;
};

export interface AccountConfigPreview {
  accountId: string;
  harness: string;
  sourceHome: string;
  entries: AccountConfigImportEntry[];
}

export interface AccountConfigImportResult {
  accountId: string;
  imported: string[];
  skipped: string[];
}

export type AccountConfigImportRefusalReason =
  | "unsupported_harness"
  | "same_home"
  | "unsafe_destination_home";

export class AccountConfigImportRefusal extends Error {
  readonly reason: AccountConfigImportRefusalReason;

  constructor(reason: AccountConfigImportRefusalReason, message: string) {
    super(message);
    this.name = "AccountConfigImportRefusal";
    this.reason = reason;
  }
}

export interface AccountConfigImportServiceOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

const MAX_FILES = 512;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TRAVERSAL_ENTRIES = 2048;
const MAX_TRAVERSAL_DEPTH = 16;

const CREDENTIAL_AND_STATE_NAMES = new Set([
  ".credentials.json",
  "auth.json",
  "cli-config.json",
  "credentials",
  "history.json",
  "history.jsonl",
  "logs",
  "projects",
  "sessions",
]);

const MIXED_CONFIG_NAMES = new Set([
  ".claude.json",
  "config.toml",
  "mcp.json",
  "opencode.json",
  "opencode.jsonc",
  "settings.json",
  "tui.toml",
]);

const PRIVATE_KEY_NAMES = new Set(["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"]);
const BLOCKED_SUFFIXES = [".db", ".jsonl", ".key", ".p12", ".pem", ".pfx", ".sqlite", ".sqlite3"];
const PRIVATE_KEY_MARKERS = [
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN DSA PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN SSH2 ENCRYPTED PRIVATE KEY-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  "PuTTY-User-Key-File-",
].map((marker) => Buffer.from(marker));

type JsonObject = { [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

type FileOperation = {
  path: string;
  destination: string;
  bytes: string | Buffer;
  mode: number;
  replace: boolean;
};

type EntryPlan = {
  preview: AccountConfigImportEntry;
  operations: FileOperation[];
  skipped: string[];
};

type ImportPlan = {
  accountId: string;
  harness: string;
  sourceHome: string;
  destinationHome: string;
  entries: EntryPlan[];
};

type SourceFile = { path: string; mode: number; size: number };
type SourceInspection =
  | { kind: "file"; file: SourceFile }
  | { kind: "directory"; path: string }
  | { kind: "skipped"; reason: string };
type PayloadBudget = { files: number; bytes: number; exhausted: boolean };
type TraversalBudget = { entries: number; truncated: boolean };
type ContentRule = "raw" | "structured";

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTomlTable(value: unknown): value is TomlTable {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function defineJsonValue(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function defineTomlValue(target: TomlTable, key: string, value: TomlValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safeRecipePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false;
  return path.split(/[\\/]+/u).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function rawPathIsBlocked(path: string): boolean {
  const parts = path.split(/[\\/]+/u).map((part) => part.toLowerCase());
  for (const part of parts) {
    if (CREDENTIAL_AND_STATE_NAMES.has(part) || MIXED_CONFIG_NAMES.has(part) || PRIVATE_KEY_NAMES.has(part)) return true;
    if (part === ".env" || part.startsWith(".env.")) return true;
  }
  const leaf = parts[parts.length - 1] ?? "";
  return BLOCKED_SUFFIXES.some((suffix) => leaf.endsWith(suffix));
}

function structuredPathIsBlocked(path: string): boolean {
  const parts = path.split(/[\\/]+/u).map((part) => part.toLowerCase());
  if (parts.some((part) => CREDENTIAL_AND_STATE_NAMES.has(part) || PRIVATE_KEY_NAMES.has(part))) return true;
  const leaf = parts[parts.length - 1] ?? "";
  return leaf === ".env" || leaf.startsWith(".env.") || BLOCKED_SUFFIXES.some((suffix) => leaf.endsWith(suffix));
}

function sourcePathIsBlocked(path: string, contentRule: ContentRule): boolean {
  return contentRule === "raw" ? rawPathIsBlocked(path) : structuredPathIsBlocked(path);
}

function rawAliasMatches(displayPath: string, actualPath: string): boolean {
  const displayExtension = extname(displayPath).toLowerCase();
  const actualExtension = extname(actualPath).toLowerCase();
  return displayExtension === actualExtension;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function canonicalExistingOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sourceCandidates(
  entry: AccountConfigImportEntryRecipe,
  sourceHome: string,
  resolvedFiles: ReadonlyMap<string, string>,
): string[] {
  if (entry.kind !== "file" || !entry.source) return [join(sourceHome, entry.path)];
  if (entry.source.kind === "resolved_recipe_file") {
    return [resolvedFiles.get(entry.source.rel) ?? join(sourceHome, entry.path)];
  }
  return entry.source.rels.map((rel) => join(sourceHome, rel));
}

function firstPresentSource(candidates: string[]): string {
  for (const candidate of candidates) {
    try {
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") return candidate;
    }
  }
  return candidates[0] ?? "";
}

function inspectSource(
  path: string,
  expected: "file" | "directory",
  sourceRoot: string,
  displayPath: string,
  contentRule: ContentRule,
): SourceInspection {
  if (sourcePathIsBlocked(displayPath, contentRule)) {
    return { kind: "skipped", reason: "entry is excluded by the config-only content policy" };
  }
  let linkStat;
  try {
    linkStat = lstatSync(path);
  } catch (error) {
    return { kind: "skipped", reason: isNodeError(error) && error.code === "ENOENT" ? "source missing" : "source is unreadable" };
  }
  let actual = path;
  if (linkStat.isSymbolicLink()) {
    try {
      actual = realpathSync(path);
    } catch {
      return { kind: "skipped", reason: "source symlink is broken" };
    }
    if (!pathInside(sourceRoot, actual)) {
      return { kind: "skipped", reason: "source symlink resolves outside the vendor home" };
    }
    const actualRelative = relative(sourceRoot, actual);
    if (sourcePathIsBlocked(actualRelative, contentRule)) {
      return { kind: "skipped", reason: "source symlink points at excluded configuration, credential, or state data" };
    }
    if (contentRule === "raw" && expected === "file" && !rawAliasMatches(displayPath, actualRelative)) {
      return { kind: "skipped", reason: "raw source symlink changes the expected content type" };
    }
  }
  let stat;
  try {
    stat = statSync(actual);
  } catch {
    return { kind: "skipped", reason: "source is unreadable" };
  }
  if (expected === "file") {
    if (!stat.isFile()) return { kind: "skipped", reason: "source is not a regular file" };
    if (stat.size > MAX_FILE_BYTES) return { kind: "skipped", reason: "source file exceeds the 1 MiB limit" };
    return { kind: "file", file: { path: actual, mode: 0o600 | (stat.mode & 0o100), size: stat.size } };
  }
  if (!stat.isDirectory()) return { kind: "skipped", reason: "source is not a directory" };
  return { kind: "directory", path: actual };
}

function destinationState(destinationHome: string, destination: string): "missing" | "file" | "directory" | "unsafe" {
  if (!pathInside(destinationHome, destination)) return "unsafe";
  const rel = relative(destinationHome, destination);
  const parts = rel === "" ? [] : rel.split(sep);
  let current = destinationHome;
  for (let index = 0; index <= parts.length; index += 1) {
    if (index > 0) current = join(current, parts[index - 1] ?? "");
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return "unsafe";
      if (index < parts.length && !stat.isDirectory()) return "unsafe";
      if (index === parts.length) {
        if (stat.isFile()) return "file";
        if (stat.isDirectory()) return "directory";
        return "unsafe";
      }
    } catch (error) {
      return isNodeError(error) && error.code === "ENOENT" ? "missing" : "unsafe";
    }
  }
  return "unsafe";
}

function ensureDestinationDirectory(destinationHome: string, directory: string): boolean {
  if (!pathInside(destinationHome, directory)) return false;
  try {
    mkdirSync(destinationHome, { mode: 0o700, recursive: true });
    const root = lstatSync(destinationHome);
    if (root.isSymbolicLink() || !root.isDirectory()) return false;
  } catch {
    return false;
  }
  const rel = relative(destinationHome, directory);
  const parts = rel === "" ? [] : rel.split(sep);
  let current = destinationHome;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") return false;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") return false;
      }
      try {
        const created = lstatSync(current);
        if (created.isSymbolicLink() || !created.isDirectory()) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

function readBoundedFile(path: string): Buffer | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return readFileSync(descriptor);
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeSyncedTemporary(path: string, bytes: string | Buffer, mode: number): void {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // Some supported filesystems do not permit directory fsync.
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeOperation(operation: FileOperation, destinationHome: string): boolean {
  const parent = dirname(operation.destination);
  if (!ensureDestinationDirectory(destinationHome, parent)) return false;
  const temporary = join(parent, `.hive-config-import-${randomUUID()}.tmp`);
  try {
    writeSyncedTemporary(temporary, operation.bytes, operation.mode);
    if (operation.replace) {
      if (destinationState(destinationHome, operation.destination) !== "file") return false;
      renameSync(temporary, operation.destination);
    } else {
      if (destinationState(destinationHome, operation.destination) !== "missing") return false;
      linkSync(temporary, operation.destination);
      unlinkSync(temporary);
    }
    syncDirectory(parent);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The publish path consumed the temporary file or cleanup already ran.
    }
  }
}

function reservePayload(budget: PayloadBudget, size: number): boolean {
  if (budget.exhausted) return false;
  if (budget.files + 1 > MAX_FILES || budget.bytes + size > MAX_TOTAL_BYTES) {
    budget.exhausted = true;
    return false;
  }
  budget.files += 1;
  budget.bytes += size;
  return true;
}

function collectDirectoryFiles(
  sourceDirectory: string,
  sourceRoot: string,
  displayRoot: string,
  payload: PayloadBudget,
): { files: Array<{ display: string; source: SourceFile }>; skipped: string[]; truncated: boolean } {
  const files: Array<{ display: string; source: SourceFile }> = [];
  const skipped: string[] = [];
  const visited = new Set<string>();
  const traversal: TraversalBudget = { entries: 0, truncated: false };
  const addSkip = (path: string): void => {
    if (skipped.length < MAX_FILES) skipped.push(path);
    else traversal.truncated = true;
  };
  const walk = (directory: string, displayDirectory: string, depth: number): void => {
    if (traversal.truncated || payload.exhausted) return;
    if (depth > MAX_TRAVERSAL_DEPTH) {
      traversal.truncated = true;
      return;
    }
    let canonical: string;
    try {
      canonical = realpathSync(directory);
    } catch {
      addSkip(displayDirectory);
      return;
    }
    if (visited.has(canonical)) {
      addSkip(displayDirectory);
      return;
    }
    visited.add(canonical);
    let handle;
    try {
      handle = opendirSync(directory);
    } catch {
      addSkip(displayDirectory);
      return;
    }
    try {
      for (;;) {
        if (traversal.entries >= MAX_TRAVERSAL_ENTRIES) {
          if (handle.readSync() !== null) traversal.truncated = true;
          return;
        }
        const dirent = handle.readSync();
        if (dirent === null) return;
        traversal.entries += 1;
        const display = `${displayDirectory}/${dirent.name}`;
        if (rawPathIsBlocked(display)) {
          addSkip(display);
          continue;
        }
        const path = join(directory, dirent.name);
        const file = inspectSource(path, "file", sourceRoot, display, "raw");
        if (file.kind === "file") {
          if (!reservePayload(payload, file.file.size)) {
            traversal.truncated = true;
            return;
          }
          files.push({ display, source: file.file });
          continue;
        }
        const child = inspectSource(path, "directory", sourceRoot, display, "raw");
        if (child.kind === "directory") walk(child.path, display, depth + 1);
        else addSkip(display);
        if (traversal.truncated || payload.exhausted) return;
      }
    } finally {
      handle.closeSync();
    }
  };
  walk(sourceDirectory, displayRoot, 0);
  return { files, skipped, truncated: traversal.truncated || payload.exhausted };
}

function safeString(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16_384 && !value.includes("\0");
}

function safeStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 256 && value.every(safeString);
}

function usableCommand(value: unknown): value is string | string[] {
  if (safeString(value)) return value.trim().length > 0;
  if (!safeStringArray(value) || value.length === 0) return false;
  const executable = value[0];
  return typeof executable === "string" && executable.trim().length > 0;
}

function containsPrivateKeyMaterial(bytes: Buffer): boolean {
  return PRIVATE_KEY_MARKERS.some((marker) => bytes.includes(marker));
}

function safeUrl(value: unknown): value is string {
  if (!safeString(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function parseJsonObject(input: string, allowComments: boolean): JsonObject | null {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(input, errors, {
    allowTrailingComma: allowComments,
    disallowComments: !allowComments,
  });
  return errors.length === 0 && isJsonObject(parsed) ? parsed : null;
}

function sanitizeMcpServers(value: unknown, dialect: "mcp" | "mcpServers"): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const result: JsonObject = {};
  for (const name of Object.keys(value).sort()) {
    const raw = value[name];
    if (!isJsonObject(raw)) continue;
    const server: JsonObject = {};
    if (safeString(raw.type)) defineJsonValue(server, "type", raw.type);
    if (safeString(raw.transport)) defineJsonValue(server, "transport", raw.transport);
    if (usableCommand(raw.command)) defineJsonValue(server, "command", raw.command);
    if (safeStringArray(raw.args)) defineJsonValue(server, "args", raw.args);
    if (safeString(raw.cwd)) defineJsonValue(server, "cwd", raw.cwd);
    if (safeUrl(raw.url)) defineJsonValue(server, "url", raw.url);
    if (typeof raw.enabled === "boolean") defineJsonValue(server, "enabled", raw.enabled);
    for (const key of ["timeout", "startupTimeoutMs", "toolTimeoutMs"] as const) {
      const candidate = raw[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) defineJsonValue(server, key, candidate);
    }
    for (const key of ["enabledTools", "disabledTools"] as const) {
      const candidate = raw[key];
      if (safeStringArray(candidate)) defineJsonValue(server, key, candidate);
    }
    if (safeString(raw.bearerTokenEnvVar)) defineJsonValue(server, "bearerTokenEnvVar", raw.bearerTokenEnvVar);
    if (dialect === "mcp" && isJsonObject(raw.environment)) {
      const environment: JsonObject = {};
      for (const key of Object.keys(raw.environment).sort()) {
        const candidate = raw.environment[key];
        if (safeString(candidate) && /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/u.test(candidate)) defineJsonValue(environment, key, candidate);
      }
      if (Object.keys(environment).length > 0) defineJsonValue(server, "environment", environment);
    }
    if (Object.hasOwn(server, "command") || Object.hasOwn(server, "url")) defineJsonValue(result, name, server);
  }
  return Object.keys(result).length > 0 ? result : null;
}

function sanitizeTomlMcpServers(safe: TomlTable): void {
  const servers = tomlTableAt(safe, ["mcp_servers"]);
  if (!servers) return;
  for (const [name, value] of Object.entries(servers)) {
    if (!isTomlTable(value)) {
      delete servers[name];
      continue;
    }
    const commandIsUsable = usableCommand(value.command);
    const urlIsUsable = safeUrl(value.url);
    if (!urlIsUsable) delete value.url;
    if (!commandIsUsable && !urlIsUsable) delete servers[name];
  }
  if (Object.keys(servers).length === 0) delete safe.mcp_servers;
}

function extractSafeJson(
  source: JsonObject,
  recipe: Extract<AccountConfigImportEntryRecipe, { kind: "file" }> & { merge: { kind: "json" } },
): JsonObject {
  const safe: JsonObject = {};
  for (const key of recipe.merge.safeKeys) {
    const value = source[key];
    if (Object.hasOwn(source, key) && value !== undefined) defineJsonValue(safe, key, value);
  }
  if (recipe.merge.mcpKey) {
    const mcp = sanitizeMcpServers(source[recipe.merge.mcpKey], recipe.merge.mcpKey);
    if (mcp) defineJsonValue(safe, recipe.merge.mcpKey, mcp);
  }
  return safe;
}

function mergeMissingJson(destination: JsonObject, source: JsonObject): boolean {
  let changed = false;
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!Object.hasOwn(destination, key)) {
      defineJsonValue(destination, key, sourceValue);
      changed = true;
      continue;
    }
    const destinationValue = destination[key];
    if (isJsonObject(destinationValue) && isJsonObject(sourceValue) && mergeMissingJson(destinationValue, sourceValue)) changed = true;
  }
  return changed;
}

function tomlTableAt(root: TomlTable, path: readonly string[]): TomlTable | null {
  let current = root;
  for (const part of path) {
    const next = current[part];
    if (!isTomlTable(next)) return null;
    current = next;
  }
  return current;
}

function ensureTomlTable(root: TomlTable, path: readonly string[]): TomlTable {
  let current = root;
  for (const part of path) {
    const existing = current[part];
    if (isTomlTable(existing)) {
      current = existing;
      continue;
    }
    const next: TomlTable = {};
    defineTomlValue(current, part, next);
    current = next;
  }
  return current;
}

function copyTomlKeys(source: TomlTable, destination: TomlTable, keys: readonly string[]): void {
  const selected = keys.includes("*") ? Object.keys(source) : keys;
  for (const key of selected) {
    const value = source[key];
    if (value !== undefined) defineTomlValue(destination, key, value);
  }
}

function extractRecipeToml(
  source: TomlTable,
  recipe: Extract<AccountConfigImportEntryRecipe, { kind: "file" }> & { merge: { kind: "toml" } },
): TomlTable {
  const safe: TomlTable = {};
  copyTomlKeys(source, safe, recipe.merge.topLevelKeys);
  for (const section of recipe.merge.exactSections ?? []) {
    const sourceTable = tomlTableAt(source, section.path);
    if (!sourceTable) continue;
    copyTomlKeys(sourceTable, ensureTomlTable(safe, section.path), section.keys);
  }
  for (const children of recipe.merge.childSections ?? []) {
    const sourceParent = tomlTableAt(source, children.path);
    if (!sourceParent) continue;
    for (const [name, value] of Object.entries(sourceParent)) {
      if (!isTomlTable(value)) continue;
      copyTomlKeys(value, ensureTomlTable(safe, [...children.path, name]), children.keys);
    }
  }
  return safe;
}

function hasOwnValue(table: TomlTable | null, key: string): boolean {
  return table !== null && Object.hasOwn(table, key);
}

function kimiModelIsUsable(model: TomlTable | null): model is TomlTable {
  return model !== null && safeString(model.provider) && safeString(model.model) &&
    ((typeof model.max_context_size === "number" && model.max_context_size > 0) || (typeof model.max_context_size === "bigint" && model.max_context_size > 0n));
}

function sanitizeKimiRelations(source: TomlTable, destination: TomlTable, safe: TomlTable): void {
  const safeProviders = tomlTableAt(safe, ["providers"]);
  const destinationProviders = tomlTableAt(destination, ["providers"]);
  if (safeProviders) {
    for (const [name, value] of Object.entries(safeProviders)) {
      const destinationValue = destinationProviders?.[name];
      const effective = hasOwnValue(destinationProviders, name) ? destinationValue : value;
      if (!isTomlTable(effective) || !safeString(effective.type)) delete safeProviders[name];
    }
    if (Object.keys(safeProviders).length === 0) delete safe.providers;
  }

  const sourceModels = tomlTableAt(source, ["models"]);
  const safeModels = tomlTableAt(safe, ["models"]);
  const destinationModels = tomlTableAt(destination, ["models"]);
  if (safeModels) {
    for (const alias of Object.keys(safeModels)) {
      const sourceModel = sourceModels && isTomlTable(sourceModels[alias]) ? sourceModels[alias] : null;
      if (!kimiModelIsUsable(sourceModel)) {
        delete safeModels[alias];
        continue;
      }
      const providerName = sourceModel.provider;
      if (!safeString(providerName)) {
        delete safeModels[alias];
        continue;
      }
      const destinationProvider = destinationProviders?.[providerName];
      const sourceProvider = tomlTableAt(safe, ["providers", providerName]);
      const effectiveProvider = hasOwnValue(destinationProviders, providerName) ? destinationProvider : sourceProvider;
      if (!isTomlTable(effectiveProvider) || !safeString(effectiveProvider.type)) delete safeModels[alias];
    }
    if (Object.keys(safeModels).length === 0) delete safe.models;
  }

  const requested = source.default_model;
  if (!safeString(requested)) return;
  const destinationModelValue = destinationModels?.[requested];
  const safeModelValue = tomlTableAt(safe, ["models", requested]);
  const effectiveModel = hasOwnValue(destinationModels, requested) ? destinationModelValue : safeModelValue;
  if (!isTomlTable(effectiveModel) || !kimiModelIsUsable(effectiveModel)) return;
  const providerName = effectiveModel.provider;
  if (!safeString(providerName)) return;
  const destinationProvider = destinationProviders?.[providerName];
  const safeProvider = tomlTableAt(safe, ["providers", providerName]);
  const effectiveProvider = hasOwnValue(destinationProviders, providerName) ? destinationProvider : safeProvider;
  if (isTomlTable(effectiveProvider) && safeString(effectiveProvider.type)) defineTomlValue(safe, "default_model", requested);
}

function mergeMissingToml(destination: TomlTable, source: TomlTable): boolean {
  let changed = false;
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!Object.hasOwn(destination, key)) {
      defineTomlValue(destination, key, sourceValue);
      changed = true;
      continue;
    }
    const destinationValue = destination[key];
    if (isTomlTable(destinationValue) && isTomlTable(sourceValue) && mergeMissingToml(destinationValue, sourceValue)) changed = true;
  }
  return changed;
}

function parseTomlTable(input: string): TomlTable | null {
  try {
    return parseToml(input, { integersAsBigInt: "asNeeded", maxDepth: 64 });
  } catch {
    return null;
  }
}

function structuredDestination(
  destinationHome: string,
  destination: string,
): { state: "missing" } | { state: "file"; bytes: Buffer } | { state: "invalid"; reason: string } {
  const state = destinationState(destinationHome, destination);
  if (state === "missing") return { state };
  if (state !== "file") return { state: "invalid", reason: "destination path is not a regular file" };
  const bytes = readBoundedFile(destination);
  if (!bytes) return { state: "invalid", reason: "destination config is unreadable or exceeds the 1 MiB limit" };
  return { state: "file", bytes };
}

function skippedFile(path: string, reason: string): EntryPlan {
  return { preview: { path, kind: "file", status: "skipped", reason }, operations: [], skipped: [path] };
}

function configPlan(
  entry: Extract<AccountConfigImportEntryRecipe, { kind: "file" }>,
  source: SourceFile,
  destinationHome: string,
  payload: PayloadBudget,
): EntryPlan {
  const destination = join(destinationHome, entry.path);
  const destinationConfig = structuredDestination(destinationHome, destination);
  if (destinationConfig.state === "invalid") return skippedFile(entry.path, destinationConfig.reason);
  if (!reservePayload(payload, source.size)) return skippedFile(entry.path, "import exceeds the bounded file or byte limit");
  const sourceBytes = readBoundedFile(source.path);
  if (!sourceBytes) return skippedFile(entry.path, "source is unreadable or changed while planning");
  if (entry.merge.kind === "copy") {
    if (destinationConfig.state !== "missing") return skippedFile(entry.path, "destination exists");
    return {
      preview: { path: entry.path, kind: "file", status: "ready" },
      operations: [{ path: entry.path, destination, bytes: sourceBytes, mode: source.mode, replace: false }],
      skipped: [],
    };
  }
  const destinationExists = destinationConfig.state === "file";
  if (entry.merge.kind === "json") {
    const allowComments = entry.merge.allowComments === true;
    const sourceJson = parseJsonObject(sourceBytes.toString("utf8"), allowComments);
    const formatName = allowComments ? "JSONC" : "JSON";
    if (!sourceJson) return skippedFile(entry.path, `source config is invalid ${formatName}`);
    const safe = extractSafeJson(sourceJson, { ...entry, merge: entry.merge });
    if (Object.keys(safe).length === 0) return skippedFile(entry.path, "source has no safe configuration values");
    const destinationJson = destinationExists
      ? parseJsonObject(destinationConfig.bytes.toString("utf8"), entry.merge.allowComments === true)
      : {};
    if (!destinationJson) return skippedFile(entry.path, `destination config is invalid ${formatName}`);
    if (!mergeMissingJson(destinationJson, safe)) return skippedFile(entry.path, "destination already contains the safe configuration");
    const text = `${JSON.stringify(destinationJson, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) return skippedFile(entry.path, "merged config exceeds the 1 MiB limit");
    return {
      preview: { path: entry.path, kind: "file", status: "ready", ...(destinationExists ? { reason: "safe missing values will be merged" } : {}) },
      operations: [{ path: entry.path, destination, bytes: text, mode: 0o600, replace: destinationExists }],
      skipped: [],
    };
  }
  const sourceToml = parseTomlTable(sourceBytes.toString("utf8"));
  if (!sourceToml) return skippedFile(entry.path, "source config is invalid TOML");
  const destinationToml = destinationExists ? parseTomlTable(destinationConfig.bytes.toString("utf8")) : {};
  if (!destinationToml) return skippedFile(entry.path, "destination config is invalid TOML");
  const safe = extractRecipeToml(sourceToml, { ...entry, merge: entry.merge });
  sanitizeTomlMcpServers(safe);
  if (entry.merge.profile === "kimi") sanitizeKimiRelations(sourceToml, destinationToml, safe);
  if (Object.keys(safe).length === 0) return skippedFile(entry.path, "source has no safe configuration values");
  if (!mergeMissingToml(destinationToml, safe)) return skippedFile(entry.path, "destination already contains the safe configuration");
  let text: string;
  try {
    text = stringifyToml(destinationToml);
  } catch {
    return skippedFile(entry.path, "merged config cannot be serialized as TOML");
  }
  if (!text.endsWith("\n")) text += "\n";
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return skippedFile(entry.path, "merged config exceeds the 1 MiB limit");
  return {
    preview: { path: entry.path, kind: "file", status: "ready", ...(destinationExists ? { reason: "safe missing values will be merged" } : {}) },
    operations: [{ path: entry.path, destination, bytes: text, mode: 0o600, replace: destinationExists }],
    skipped: [],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export class AccountConfigImportService {
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly home: string;

  constructor(options: AccountConfigImportServiceOptions = {}) {
    this.env = options.env ?? process.env;
    const configuredHome = options.home ?? this.env.HOME?.trim() ?? homedir();
    this.home = resolve(configuredHome || homedir());
  }

  preview(account: AccountRow): AccountConfigPreview {
    const plan = this.plan(account);
    return {
      accountId: plan.accountId,
      harness: plan.harness,
      sourceHome: plan.sourceHome,
      entries: plan.entries.map((entry) => entry.preview),
    };
  }

  import(account: AccountRow): AccountConfigImportResult {
    const plan = this.plan(account);
    const imported: string[] = [];
    const skipped = plan.entries.flatMap((entry) => entry.skipped);
    for (const entry of plan.entries) {
      for (const operation of entry.operations) {
        if (writeOperation(operation, plan.destinationHome)) imported.push(operation.path);
        else skipped.push(operation.path);
      }
    }
    return { accountId: account.id, imported: unique(imported), skipped: unique(skipped) };
  }

  private plan(account: AccountRow): ImportPlan {
    const recipe = accountConfigImportRecipeFor(account.harness);
    const vendor = resolveVendorHome(account.harness, this.env, this.home);
    if (!recipe || !vendor) {
      throw new AccountConfigImportRefusal("unsupported_harness", `configuration import is unsupported for harness ${account.harness}`);
    }
    const sourceHome = resolve(vendor.vendorHome);
    const destinationHome = resolve(account.homePath);
    if (canonicalExistingOrResolved(sourceHome) === canonicalExistingOrResolved(destinationHome)) {
      throw new AccountConfigImportRefusal("same_home", "account home must differ from the vendor configuration home");
    }
    try {
      const destinationRoot = lstatSync(destinationHome);
      if (destinationRoot.isSymbolicLink() || !destinationRoot.isDirectory()) {
        throw new AccountConfigImportRefusal("unsafe_destination_home", "account home is not a real directory");
      }
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    }
    const sourceRoot = canonicalExistingOrResolved(sourceHome);
    const resolvedFiles = new Map(vendor.files.map((file) => [file.rel, file.path]));
    const payload: PayloadBudget = { files: 0, bytes: 0, exhausted: false };
    const entries: EntryPlan[] = [];
    for (const entry of recipe.entries) {
      if (!safeRecipePath(entry.path)) {
        throw new AccountConfigImportRefusal("unsupported_harness", `configuration recipe for ${account.harness} contains an unsafe path`);
      }
      const candidates = sourceCandidates(entry, sourceHome, resolvedFiles);
      const sourcePath = firstPresentSource(candidates);
      const contentRule: ContentRule = entry.kind === "file" && entry.merge.kind !== "copy" ? "structured" : "raw";
      const inspected = inspectSource(sourcePath, entry.kind, sourceRoot, entry.path, contentRule);
      if (inspected.kind === "skipped") {
        entries.push({ preview: { path: entry.path, kind: entry.kind, status: "skipped", reason: inspected.reason }, operations: [], skipped: [entry.path] });
        continue;
      }
      if (entry.kind === "file") {
        if (inspected.kind !== "file") {
          entries.push(skippedFile(entry.path, "source is not a regular file"));
          continue;
        }
        entries.push(configPlan(entry, inspected.file, destinationHome, payload));
        continue;
      }
      if (inspected.kind !== "directory") {
        entries.push({ preview: { path: entry.path, kind: "directory", status: "skipped", reason: "source is not a directory" }, operations: [], skipped: [entry.path] });
        continue;
      }
      const collected = collectDirectoryFiles(inspected.path, sourceRoot, entry.path, payload);
      const operations: FileOperation[] = [];
      const skipped = [...collected.skipped];
      for (const file of collected.files) {
        const destination = join(destinationHome, file.display);
        if (destinationState(destinationHome, destination) !== "missing") {
          skipped.push(file.display);
          continue;
        }
        const bytes = readBoundedFile(file.source.path);
        if (!bytes || containsPrivateKeyMaterial(bytes)) {
          skipped.push(file.display);
          continue;
        }
        operations.push({ path: file.display, destination, bytes, mode: file.source.mode, replace: false });
      }
      if (collected.truncated) skipped.push(entry.path);
      const reason = operations.length > 0
        ? collected.truncated
          ? `${operations.length} file(s) ready; traversal stopped at the bounded limit`
          : skipped.length > 0 ? `${operations.length} file(s) ready; ${skipped.length} skipped` : undefined
        : collected.truncated
          ? "source directory traversal stopped at the bounded limit"
          : collected.files.length === 0 ? "source directory has no safe files" : "destination already contains every safe file";
      entries.push({
        preview: { path: entry.path, kind: "directory", status: operations.length > 0 ? "ready" : "skipped", ...(reason ? { reason } : {}) },
        operations,
        skipped: operations.length === 0 && skipped.length === 0 ? [entry.path] : unique(skipped),
      });
    }
    return { accountId: account.id, harness: account.harness, sourceHome, destinationHome, entries };
  }
}
