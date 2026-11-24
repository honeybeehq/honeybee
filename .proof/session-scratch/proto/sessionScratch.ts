// Prototype of the design's one function: turn a harness command into one whose /tmp is the bee's scratch
// and whose processes cannot outlive it. Pure argv construction, like bwrapArgs in v2/driver-cell/src/sandbox.ts.
import { bwrapArgs, type SandboxPolicy } from "../../../v2/driver-cell/src/sandbox.ts";

export interface SessionScratch {
  scratchDir: string;        // <dataDir>/tmp/<beeId>: what the session sees as /tmp
  shmBytes: number;          // private /dev/shm cap
  passthrough?: string[];    // host paths under /tmp that the session is given on purpose (X11, an ssh agent socket, a share)
}

function captureArgs(s: SessionScratch): string[] {
  const out = [
    "--bind", s.scratchDir, "/tmp",
    "--bind", `${s.scratchDir}/.var-tmp`, "/var/tmp",
    "--size", String(s.shmBytes), "--tmpfs", "/dev/shm",
    "--unshare-pid", "--proc", "/proc",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "HIVE_SCRATCH", "/tmp",
    "--setenv", "HIVE_SCRATCH_HOST", s.scratchDir,
  ];
  for (const p of s.passthrough ?? []) out.push("--bind-try", p, p);
  return out;
}

/** A bee without confinement (workstation default today): the host's root as it is, plus capture. */
export function openSessionArgs(s: SessionScratch, command: string, args: string[]): string[] {
  return ["--dev-bind", "/", "/", ...captureArgs(s), "--die-with-parent", "--", command, ...args];
}

/** A confined bee: today's bwrapArgs with its private tmpfs mounts replaced by the capture. */
export function confinedSessionArgs(policy: SandboxPolicy, s: SessionScratch, command: string, args: string[]): string[] {
  const base = bwrapArgs({ ...policy, tmpfsBytes: null }, command, args);
  const out: string[] = [];
  for (let i = 0; i < base.length; i += 1) {
    if (base[i] === "--tmpfs" && (base[i + 1] === "/tmp" || base[i + 1] === "/var/tmp")) { i += 1; continue; }
    if (base[i] === "--proc" && base[i + 1] === "/proc") { i += 1; continue; }
    if (base[i] === "--share-net") out.push(...captureArgs(s));
    out.push(base[i]!);
  }
  return out;
}
