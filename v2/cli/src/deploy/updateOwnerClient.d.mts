export function recordedSocketPath(dataDir: string): string;
export function inspectProcess(pid: number):
  | { kind: "present"; pid: number; birth: string; bootId: string; state: "live" | "zombie" }
  | { kind: "gone" }
  | { kind: "unavailable"; reason: string };
export function readLiveUpdateOwner(socketPath: string, dataDir: string): Promise<
  { kind: "offline" } | { kind: "live"; owner: unknown }
>;
