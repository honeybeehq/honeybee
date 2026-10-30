import { flag, type Parsed } from "../parse.js";

export const REMOVED_TRACK_FLAGS = ["track", "track-version", "track-prompt"] as const;

export class RemovedFlagError extends Error {
  constructor(readonly flags: readonly string[], readonly command: string) {
    super(`hive ${command}: ${flags.map((f) => `--${f}`).join(", ")} ${flags.length === 1 ? "was" : "were"} removed with tracks; drop the flag and spawn without it`);
    this.name = "RemovedFlagError";
  }
}

export function refuseRemovedTrackFlags(parsed: Parsed, command: string): void {
  const present = REMOVED_TRACK_FLAGS.filter((name) => flag(parsed, name) !== undefined);
  if (present.length > 0) throw new RemovedFlagError(present, command);
}
