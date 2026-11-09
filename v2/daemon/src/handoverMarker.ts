import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RuntimeHandoverMarker } from "./protocol.ts";

export const HANDOVER_FILE_NAME = "handover.json";
export const HANDOVER_HOLD_MS = 60_000;

export function runtimeRootOf(dataDir: string): string {
  return join(dirname(resolve(dataDir)), "runtime");
}

export async function readHandoverMarker(root: string): Promise<RuntimeHandoverMarker | null> {
  let parsed: Partial<RuntimeHandoverMarker> | null;
  try { parsed = JSON.parse(await readFile(join(root, HANDOVER_FILE_NAME), "utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || typeof parsed.toSha !== "string" || !Number.isSafeInteger(parsed.fromPid) || !Number.isSafeInteger(parsed.at)) return null;
  return { fromPid: parsed.fromPid!, fromSha: typeof parsed.fromSha === "string" ? parsed.fromSha : null, toSha: parsed.toSha, at: parsed.at! };
}
