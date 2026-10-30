import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

export const TRANSCRIPT_OBJECT_DIR = join("blobs", "transcript-archives");
const REF = /^[a-f0-9]{64}$/;

export interface TranscriptObject {
  ref: string;
  bytes: number;
}

export interface TranscriptObjectStore {
  readonly locator: { kind: "directory"; root: string };
  putBytes(bytes: Uint8Array): TranscriptObject;
  stat(ref: string): { bytes: number } | null;
  read(ref: string): Buffer | null;
}

export function transcriptObjectPath(root: string, ref: string): string {
  if (!REF.test(ref)) throw new Error(`invalid transcript object reference ${ref}`);
  return join(root, TRANSCRIPT_OBJECT_DIR, ref);
}

export function createDirectoryTranscriptObjectStore(root: string): TranscriptObjectStore {
  const dir = join(root, TRANSCRIPT_OBJECT_DIR);
  return {
    locator: { kind: "directory", root },
    putBytes(bytes) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const ref = createHash("sha256").update(bytes).digest("hex");
      const target = transcriptObjectPath(root, ref);
      try {
        const existing = statSync(target);
        if (existing.size === bytes.length) return { ref, bytes: bytes.length };
        rmSync(target, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const temporary = join(dir, `${randomUUID()}.partial`);
      const fd = openSync(temporary, "wx", 0o600);
      try {
        let written = 0;
        while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(temporary, target);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      return { ref, bytes: bytes.length };
    },
    stat(ref) {
      try {
        return { bytes: statSync(transcriptObjectPath(root, ref)).size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    read(ref) {
      try {
        return readFileSync(transcriptObjectPath(root, ref));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
