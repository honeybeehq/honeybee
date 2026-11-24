import { closeSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonRetryableStartError } from "../../harness/src/driver.ts";
import { repoLocalConfigText, tryGit, type GitResult } from "./git.ts";

const PARTIAL_CLONE_CONFIG_HINT = /partialclone|promisor/i;

const SHOWN_MISSING_OBJECTS = 3;

export class CellSourceRefusal extends NonRetryableStartError {
  constructor(message: string) {
    super(message);
    this.name = "CellSourceRefusal";
  }
}

export function isNonRetryableProvisionError(error: unknown): boolean {
  return error instanceof NonRetryableStartError;
}

function promisorRemotes(originRepo: string): string[] | null {
  const localConfig = repoLocalConfigText(originRepo);
  if (localConfig !== null && !PARTIAL_CLONE_CONFIG_HINT.test(localConfig)) return null;
  const config = tryGit(originRepo, ["config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$"]);
  if (config.status !== 0) return null;
  const remotes = new Set<string>();
  let partial = false;
  for (const line of config.stdout.split("\n")) {
    const [key = "", value = ""] = line.trim().split(/\s+/, 2);
    if (key.toLowerCase() === "extensions.partialclone" && value.length > 0) {
      partial = true;
      remotes.add(value);
    }
    const promisor = /^remote\.(.+)\.promisor$/i.exec(key);
    if (promisor && value.toLowerCase() === "true") {
      partial = true;
      remotes.add(promisor[1] as string);
    }
  }
  return partial ? [...remotes] : null;
}

export type CellSourceCheckpoint = "provision" | "spawn";

const NEXT_STEP: Record<CellSourceCheckpoint, string> = {
  provision: "hydrate the source clone on the host and revive the bee",
  spawn: "hydrate the source clone on the host, then spawn again",
};

function remediation(originRepo: string, remote: string, checkpoint: CellSourceCheckpoint): string {
  return `To fix, ${NEXT_STEP[checkpoint]}: run \`git -C ${originRepo} backfill --no-sparse\` (Git 2.49+; plain backfill stays inside a sparse checkout), or \`git -C ${originRepo} fetch --refetch --no-filter ${remote}\`, or replace it with a full clone made without --filter. Honeybee does not fetch the objects itself: Cell checkout keeps lazy fetching off so it never contacts a remote with your credentials.`;
}

function sparseCheckoutEnabled(originRepo: string): boolean {
  const sparse = tryGit(originRepo, ["config", "--type=bool", "--get", "core.sparseCheckout"]);
  return sparse.status === 0 && sparse.stdout.trim() === "true";
}

interface MissingObjects {
  count: number;
  shown: string[];
}

function scanMissingObjects(listingPath: string): MissingObjects {
  const found: MissingObjects = { count: 0, shown: [] };
  const record = (line: string): void => {
    if (!line.startsWith("?")) return;
    found.count += 1;
    if (found.shown.length < SHOWN_MISSING_OBJECTS) found.shown.push(line.slice(1).trim());
  };
  const fd = openSync(listingPath, "r");
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let partialLine = "";
    for (let bytes = readSync(fd, chunk); bytes > 0; bytes = readSync(fd, chunk)) {
      const lines = (partialLine + chunk.toString("latin1", 0, bytes)).split("\n");
      partialLine = lines.pop() as string;
      lines.forEach(record);
    }
    record(partialLine);
  } finally {
    closeSync(fd);
  }
  return found;
}

function listCommitObjects(originRepo: string, sha: string): { listing: GitResult; missing: MissingObjects } {
  const dir = mkdtempSync(join(tmpdir(), "hb-partial-clone-"));
  try {
    const listingPath = join(dir, "objects");
    const fd = openSync(listingPath, "w");
    let listing: GitResult;
    try {
      listing = tryGit(originRepo, ["rev-list", "--objects", "--no-object-names", "--missing=print", "--no-walk", sha, "--"], { stdoutFd: fd });
    } finally {
      closeSync(fd);
    }
    return { listing, missing: listing.status === 0 ? scanMissingObjects(listingPath) : { count: 0, shown: [] } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function refuseMissingCommitObjects(originRepo: string, sha: string, remotes: string[], checkpoint: CellSourceCheckpoint): void {
  const remote = remotes[0] ?? "origin";
  const { listing, missing } = listCommitObjects(originRepo, sha);
  if (listing.status !== 0) {
    throw new CellSourceRefusal(
      `source ${originRepo} is a partial clone (promisor remote ${remote}) and commit ${sha} cannot be read locally: ${listing.stderr.trim().replace(/\s+/g, " ")}. ${remediation(originRepo, remote, checkpoint)}`,
    );
  }
  if (missing.count === 0) return;
  const more = missing.count > SHOWN_MISSING_OBJECTS ? ` and ${missing.count - SHOWN_MISSING_OBJECTS} more` : "";
  throw new CellSourceRefusal(
    `source ${originRepo} is a partial clone (promisor remote ${remote}) and is missing ${missing.count} object(s) that commit ${sha} needs (${missing.shown.join(", ")}${more}). ${remediation(originRepo, remote, checkpoint)}`,
  );
}

export function assertSourceHasCommitObjects(originRepo: string, sha: string, checkpoint: CellSourceCheckpoint = "provision"): void {
  const remotes = promisorRemotes(originRepo);
  if (remotes == null || sparseCheckoutEnabled(originRepo)) return;
  refuseMissingCommitObjects(originRepo, sha, remotes, checkpoint);
}

export function assertCloneFallbackHasCommitObjects(originRepo: string, sha: string): void {
  const remotes = promisorRemotes(originRepo);
  if (remotes != null && sparseCheckoutEnabled(originRepo)) refuseMissingCommitObjects(originRepo, sha, remotes, "provision");
}
