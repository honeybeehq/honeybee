export const CELL_REPO_REPORT_BYTES = 1024 * 1024;
export const CELL_REPO_REQUEST_BYTES = 64 * 1024;
export const CELL_REPO_DIAGNOSTIC_BYTES = 64 * 1024;
export const CELL_REPO_STATUS_BYTES = 512 * 1024;

export interface CellRepoIdentity {
  cellsRoot: string;
  wrapper: string;
  spaceDir: string;
  sandboxed: boolean;
  independentInodes: boolean;
}

export type CellRepoRequest = { operation: "inspect"; ignored: boolean };

export interface CellRepoInspection {
  head: string;
  status: string;
  branches: Array<{ ref: string; sha: string }>;
  stashed: boolean;
}

export type CellRepoFailure = "unavailable" | "identity_changed" | "invalid_repository" | "deadline" | "output_limit" | "invalid_output" | "invalid_request" | "git_failed";

export function cellRepoFailure(value: unknown): CellRepoFailure | null {
  return typeof value === "string" && ["unavailable", "identity_changed", "invalid_repository", "deadline", "output_limit", "invalid_output", "invalid_request", "git_failed"].includes(value) ? value as CellRepoFailure : null;
}

export class CellRepoRefusal extends Error {
  readonly code: CellRepoFailure;
  constructor(code: CellRepoFailure) {
    super(`Cell repository operation refused: ${code}`);
    this.name = "CellRepoRefusal";
    this.code = code;
  }
}

export function parseCellRepoRequest(value: unknown): CellRepoRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CellRepoRefusal("invalid_request");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || row.operation !== "inspect" || typeof row.ignored !== "boolean") throw new CellRepoRefusal("invalid_request");
  return { operation: "inspect", ignored: row.ignored };
}

export function parseCellRepoInspection(value: unknown): CellRepoInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CellRepoRefusal("invalid_output");
  const row = value as Record<string, unknown>;
  const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  if (Object.keys(row).length !== 4 || typeof row.head !== "string" || !sha.test(row.head)
    || typeof row.status !== "string" || Buffer.byteLength(row.status) > CELL_REPO_REPORT_BYTES
    || typeof row.stashed !== "boolean" || !Array.isArray(row.branches) || row.branches.length > 10_000) throw new CellRepoRefusal("invalid_output");
  const branches = row.branches.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new CellRepoRefusal("invalid_output");
    const branch = item as Record<string, unknown>;
    if (Object.keys(branch).length !== 2 || typeof branch.ref !== "string" || !branch.ref.startsWith("refs/heads/")
      || Buffer.byteLength(branch.ref) > 4096 || /[\x00-\x20\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(branch.ref)
      || typeof branch.sha !== "string" || !sha.test(branch.sha)) throw new CellRepoRefusal("invalid_output");
    return { ref: branch.ref, sha: branch.sha };
  });
  return { head: row.head, status: row.status, branches, stashed: row.stashed };
}
