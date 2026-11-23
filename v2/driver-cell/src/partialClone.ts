import { repoLocalConfigText, tryGit } from "./git.ts";

const PARTIAL_CLONE_CONFIG_HINT = /partialclone|promisor/i;

const SHOWN_MISSING_OBJECTS = 3;

export class CellSourceRefusal extends Error {
  readonly retryable = false as const;
  readonly code: "partial_clone_missing_objects";

  constructor(code: "partial_clone_missing_objects", message: string) {
    super(message);
    this.name = "CellSourceRefusal";
    this.code = code;
  }
}

export function isNonRetryableProvisionError(error: unknown): boolean {
  return (error as { retryable?: unknown } | null)?.retryable === false;
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

function remediation(originRepo: string, remote: string): string {
  return `To fix, hydrate the source clone on the host and revive the bee: run \`git -C ${originRepo} backfill\` (Git 2.49+), or \`git -C ${originRepo} fetch --refetch --no-filter ${remote}\`, or replace it with a full clone made without --filter. Honeybee does not fetch the objects itself: Cell checkout keeps lazy fetching off so it never contacts a remote with your credentials.`;
}

export function assertSourceHasCommitObjects(originRepo: string, sha: string): void {
  const remotes = promisorRemotes(originRepo);
  if (remotes == null) return;
  const remote = remotes[0] ?? "origin";
  const listing = tryGit(originRepo, ["rev-list", "--objects", "--missing=print", "--no-walk", sha, "--"]);
  if (listing.status !== 0) {
    throw new CellSourceRefusal(
      "partial_clone_missing_objects",
      `source ${originRepo} is a partial clone (promisor remote ${remote}) and commit ${sha} cannot be read locally: ${listing.stderr.trim().replace(/\s+/g, " ")}. ${remediation(originRepo, remote)}`,
    );
  }
  const missing = listing.stdout.split("\n").filter((line) => line.startsWith("?")).map((line) => line.slice(1).trim());
  if (missing.length === 0) return;
  const shown = missing.slice(0, SHOWN_MISSING_OBJECTS).join(", ");
  const more = missing.length > SHOWN_MISSING_OBJECTS ? ` and ${missing.length - SHOWN_MISSING_OBJECTS} more` : "";
  throw new CellSourceRefusal(
    "partial_clone_missing_objects",
    `source ${originRepo} is a partial clone (promisor remote ${remote}) and is missing ${missing.length} object(s) that commit ${sha} needs (${shown}${more}). ${remediation(originRepo, remote)}`,
  );
}
