/**
 * Package format — "rows are truth, files are packages" (spec 06 §1.4.1).
 *
 * A template exports to / imports from a stable, human-editable JSON
 * document with a `kind` + `formatVersion` header. Both directions are
 * deterministic: `serializePackage(exportTemplate(row))` is byte-stable, and
 * import is idempotent (same package twice = one row, updated — or left alone
 * when nothing changed). Import records the row's `source`.
 *
 * Local config files (`~/.hive/templates`) are a
 * first-class local package source: `importLocalConfig(store, dir)` reads
 * today's on-disk layout, converts each file to a package and imports it with
 * source `local-config`. Manual invocation only in v1 — see
 * `LOCAL_CONFIG_AUTO_IMPORT_HOOK` below for the recorded FUTURE requirement.
 *
 * Pure over the store API: no writes outside CoreStore, read-only file access.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { CoreStore, PutOutcome } from "./store.ts";
import { PackageError, type RowSource, type Scope, type TemplateRow } from "./types.ts";
import { isScope, normalizeTemplate } from "./registry.ts";

export const PACKAGE_FORMAT_VERSION = 1 as const;
export const TEMPLATE_PACKAGE_KIND = "hive.template" as const;

/** The portable template document. Key order below IS the serialized order. */
export interface TemplatePackage {
  kind: typeof TEMPLATE_PACKAGE_KIND;
  formatVersion: typeof PACKAGE_FORMAT_VERSION;
  /** Stable id; null in hand-written packages (import matches by scope+name, then mints one). */
  id: string | null;
  name: string;
  scope: Scope;
  description: string | null;
  agent: string;
  substrate: string | null;
  model: string | null;
  effort: string | null;
  args: string[];
  prompt: string;
  preamble: string | null;
  preambleEnabled: boolean;
  cwdPolicy: TemplateRow["cwdPolicy"];
  cwd: string | null;
  env: Record<string, string>;
  account: string | null;
  yolo: boolean;
  tags: string[];
}

export type Package = TemplatePackage;

export interface ImportOptions {
  /** Recorded on the row. Default `package:rpc`. */
  source?: RowSource;
  /** Override the package's scope (e.g. a repo `.hive/` import forces `repo`). */
  scope?: Scope;
  /** Label for error messages (usually the file path). */
  label?: string;
}

export interface ImportResult<T> {
  row: T;
  outcome: PutOutcome;
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export function exportTemplate(row: TemplateRow): TemplatePackage {
  return {
    kind: TEMPLATE_PACKAGE_KIND,
    formatVersion: PACKAGE_FORMAT_VERSION,
    id: row.id,
    name: row.name,
    scope: row.scope,
    description: row.description,
    agent: row.agent,
    substrate: row.substrate,
    model: row.model,
    effort: row.effort,
    args: [...row.args],
    prompt: row.prompt,
    preamble: row.preamble,
    preambleEnabled: row.preambleEnabled,
    cwdPolicy: row.cwdPolicy,
    cwd: row.cwd,
    env: sortedRecord(row.env),
    account: row.account,
    yolo: row.yolo,
    tags: [...row.tags],
  };
}

/** Canonical text form: 2-space JSON, trailing newline, fixed key order. */
export function serializePackage(doc: Package): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function sortedRecord(r: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(r).sort()) out[k] = r[k] as string;
  return out;
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

function parseDoc(input: unknown, label?: string): Record<string, unknown> {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (err) {
      throw new PackageError(`${label ? `${label}: ` : ""}package is not valid json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageError(`${label ? `${label}: ` : ""}package must be a json object`);
  }
  return value as Record<string, unknown>;
}

function checkHeader(doc: Record<string, unknown>, kind: string, label?: string): void {
  const prefix = label ? `${label}: ` : "";
  if (doc.kind !== kind) throw new PackageError(`${prefix}package kind must be '${kind}', got ${JSON.stringify(doc.kind ?? null)}`);
  if (doc.formatVersion !== PACKAGE_FORMAT_VERSION) {
    throw new PackageError(`${prefix}unsupported formatVersion ${JSON.stringify(doc.formatVersion ?? null)} (this node reads ${PACKAGE_FORMAT_VERSION})`);
  }
}

function optionalId(doc: Record<string, unknown>, label?: string): string | null {
  const id = doc.id;
  if (id === undefined || id === null) return null;
  if (typeof id !== "string" || id.length === 0) throw new PackageError(`${label ? `${label}: ` : ""}package id must be a non-empty string`);
  return id;
}

/** Validate a template package (object or json text) into its canonical document. */
export function parseTemplatePackage(input: unknown, label?: string): TemplatePackage {
  const doc = parseDoc(input, label);
  checkHeader(doc, TEMPLATE_PACKAGE_KIND, label);
  const { source: _source, ...rest } = doc; // packages never carry a source — the importer records it
  const fields = normalizeTemplate(rest, { label });
  return {
    kind: TEMPLATE_PACKAGE_KIND,
    formatVersion: PACKAGE_FORMAT_VERSION,
    id: optionalId(doc, label),
    name: fields.name,
    scope: fields.scope,
    description: fields.description,
    agent: fields.agent,
    substrate: fields.substrate,
    model: fields.model,
    effort: fields.effort,
    args: fields.args,
    prompt: fields.prompt,
    preamble: fields.preamble,
    preambleEnabled: fields.preambleEnabled,
    cwdPolicy: fields.cwdPolicy,
    cwd: fields.cwd,
    env: fields.env,
    account: fields.account,
    yolo: fields.yolo,
    tags: fields.tags,
  };
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

export function importTemplate(store: CoreStore, input: unknown, opts: ImportOptions = {}): ImportResult<TemplateRow> {
  const doc = parseTemplatePackage(input, opts.label);
  const { kind: _k, formatVersion: _v, id, ...fields } = doc;
  const res = store.putTemplate({
    id: id ?? undefined,
    fields: { ...fields, scope: opts.scope ?? fields.scope, source: opts.source ?? "package:rpc" },
    label: opts.label,
  });
  return { row: res.template, outcome: res.outcome };
}

// ---------------------------------------------------------------------------
// local config source (~/.hive/templates)
// ---------------------------------------------------------------------------

export interface LocalConfigImportEntry {
  path: string;
  name: string;
  id: string;
  outcome: PutOutcome;
}

export interface LocalConfigSkip {
  path: string;
  reason: string;
}

export interface LocalConfigImportReport {
  dir: string;
  templates: LocalConfigImportEntry[];
  skipped: LocalConfigSkip[];
}

export interface LocalConfigImportOptions {
  /** Scope recorded on imported rows. Default `personal` (local config = this node). */
  scope?: Scope;
}

/**
 * Convert an OLD-layout template file (`~/.hive/templates/<name>.json`) to a
 * v1 template package. Field mapping (old → new):
 *   bee → agent · prompt → prompt · cwd "caller" → cwdPolicy caller ·
 *   cwd "/abs" → cwdPolicy fixed + cwd · args/env/account/yolo/description → same ·
 *   preamble string → preamble (enabled) · preamble false → preambleEnabled false ·
 *   createdAt/updatedAt → dropped (hive owns timestamps).
 * model/effort/substrate/tags have no old equivalent → null/empty.
 */
export function legacyTemplateToPackage(value: unknown, label?: string): TemplatePackage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageError(`${label ? `${label}: ` : ""}legacy template must be an object`);
  }
  const o = value as Record<string, unknown>;
  const cwd = o.cwd;
  const preamble = o.preamble;
  const candidate: Record<string, unknown> = {
    kind: TEMPLATE_PACKAGE_KIND,
    formatVersion: PACKAGE_FORMAT_VERSION,
    name: o.name,
    scope: "personal",
    description: o.description ?? null,
    agent: o.bee,
    args: o.args ?? [],
    prompt: o.prompt,
    preamble: typeof preamble === "string" ? preamble : null,
    preambleEnabled: preamble !== false,
    cwdPolicy: cwd === undefined || cwd === "caller" ? "caller" : "fixed",
    cwd: cwd === undefined || cwd === "caller" ? null : cwd,
    env: o.env ?? {},
    account: o.account ?? null,
    yolo: o.yolo ?? false,
    tags: [],
  };
  return parseTemplatePackage(candidate, label);
}

/**
 * Import today's `~/.hive`-style local config as a package source. Reads
 * `<dir>/templates/*.json` (top-level files only). Per-file failures are reported as `skipped`, never thrown.
 * Rows are recorded with source `local-config`. Read-only on the filesystem.
 */
export function importLocalConfig(store: CoreStore, dir: string, opts: LocalConfigImportOptions = {}): LocalConfigImportReport {
  const scope: Scope = opts.scope ?? "personal";
  if (!isScope(scope)) throw new PackageError(`scope must be personal|team|repo`);
  const report: LocalConfigImportReport = { dir, templates: [], skipped: [] };
  const source: RowSource = "local-config";

  const templatesDir = join(dir, "templates");
  for (const path of listJsonFiles(templatesDir, report)) {
    try {
      const doc = legacyTemplateToPackage(JSON.parse(readFileSync(path, "utf8")), path);
      const res = importTemplate(store, doc, { source, scope, label: path });
      report.templates.push({ path, name: res.row.name, id: res.row.id, outcome: res.outcome });
    } catch (err) {
      report.skipped.push({ path, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return report;
}

function listJsonFiles(dir: string, report: LocalConfigImportReport): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue; // versions/ dirs, attachments — not definitions
    const ext = extname(entry);
    if (ext === ".json") out.push(path);
    else if (ext === ".ts") report.skipped.push({ path, reason: "typescript definitions are not importable as packages — save it as json first" });
    // `.source` remembered-source markers and anything else: silently ignored.
  }
  return out;
}

/**
 * FUTURE REQUIREMENT (spec 06 §1.4.1, recorded, not v1): automatic import/sync
 * of package sources — `~/.hive/*` local config on change and repo `.hive/*`
 * on spawn. When a watcher lands, it calls exactly this hook per changed
 * source dir; nothing calls it today, and no watching is implemented. Manual
 * `packages.importLocalConfig` is the only v1 entry point.
 */
export const LOCAL_CONFIG_AUTO_IMPORT_HOOK = {
  implemented: false as const,
  onLocalConfigChanged(store: CoreStore, dir: string, opts: LocalConfigImportOptions = {}): LocalConfigImportReport {
    return importLocalConfig(store, dir, opts);
  },
};
