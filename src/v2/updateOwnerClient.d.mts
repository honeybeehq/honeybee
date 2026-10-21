export function recordedSocketPath(dataDir: string): string;
export function readLiveUpdateOwner(socketPath: string, dataDir: string): Promise<
  { kind: "offline" } | { kind: "live"; owner: unknown }
>;
