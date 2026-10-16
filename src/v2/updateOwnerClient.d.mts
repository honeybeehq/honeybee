export function readLiveUpdateOwner(socketPath: string, dataDir: string): Promise<
  { kind: "offline" } | { kind: "live"; owner: unknown }
>;
