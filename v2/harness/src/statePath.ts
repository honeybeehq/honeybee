import { dirname, isAbsolute, parse, resolve } from "node:path";

export class StatePathError extends Error {
  readonly code = "invalid_runtime_root";
  constructor(field: string) { super(`${field} requires an explicit absolute non-root state directory`); this.name = "StatePathError"; }
}

export function stateDirectory(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value) || value.includes("\0")) throw new StatePathError(field);
  const path = resolve(value);
  if (path === parse(path).root) throw new StatePathError(field);
  return path;
}

export function stateFile(value: unknown, field: string): string {
  const path = stateDirectory(value, field);
  stateDirectory(dirname(path), field + " parent");
  return path;
}

export function runnerStateFiles(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StatePathError("runner config");
  const files = value as Record<string, unknown>;
  for (const field of ["sessionLogPath", "observationLogPath", "sidecarPath", "socketPath", "statusPath"] as const) stateFile(files[field], field);
}
