import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, isAbsolute } from "node:path";
import { pinThreadHistory } from "./threadHistory.ts";
import type { ThreadOperationRow } from "../../core/src/threadOperation.ts";

export function codexSwapHistoryPath(home: string, beeId: string, sessionId: string): string {
  const key = createHash("sha256").update(JSON.stringify([beeId, sessionId])).digest("hex");
  return join(home, "sessions", "honeybee", `${key}.jsonl`);
}

export function validateCodexSwapPath(home: string, path: string): void {
  const base = realpathSync(home);
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const target = realpathSync(ancestor);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Codex rollout must be inside its account home");
}

export function carryCodexHistory(source: ThreadOperationRow["source"], home: string, destination: string, sessionId: string): "present" {
  validateCodexSwapPath(home, destination);
  mkdirSync(dirname(destination), { recursive: true });
  validateCodexSwapPath(home, destination);
  const input = openSync(source.path, "r");
  const temporary = join(dirname(destination), `.${randomUUID()}.partial`);
  try {
    const stat = fstatSync(input);
    if (stat.dev !== source.dev || stat.ino !== source.ino || stat.size < source.bytes) throw new Error("Pinned Codex rollout changed");
    const name = lstatSync(source.path);
    if (!name.isFile() || name.dev !== source.dev || name.ino !== source.ino) throw new Error("Pinned Codex rollout must be a regular file");
    if (existsSync(destination)) {
      const present = lstatSync(destination);
      if (present.isFile() && present.dev === source.dev && present.ino === source.ino) return "present";
    }
    linkSync(source.path, temporary);
    const linked = lstatSync(temporary);
    if (!linked.isFile() || linked.dev !== source.dev || linked.ino !== source.ino) throw new Error("Pinned Codex rollout changed during link");
    pinThreadHistory(temporary, sessionId);
    renameSync(temporary, destination);
  } catch (error) {
    try {
      if (existsSync(temporary)) {
        const trash = join(home, ".honeybee-rollout-trash");
        validateCodexSwapPath(home, trash);
        mkdirSync(trash, { recursive: true });
        validateCodexSwapPath(home, trash);
        renameSync(temporary, join(trash, randomUUID()));
      }
    } catch {}
    throw error;
  } finally { closeSync(input); }
  const directory = openSync(dirname(destination), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return "present";
}
