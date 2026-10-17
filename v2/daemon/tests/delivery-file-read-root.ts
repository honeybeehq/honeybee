import { isAbsolute, join } from "node:path";

export const DELIVERY_READ_SOCKET_NAME = `hb-rh-${"0".repeat(16)}.sock`;

export function outsideLinuxPrivateMounts(path: string): boolean {
  return ["/tmp", "/var/tmp", "/dev"].every(mount => path !== mount && !path.startsWith(mount + "/"));
}

export function deliveryReadFixtureBase(platform: string, sandboxed: boolean, tempDir: string, runnerTemp: string | undefined, cwd: string): string {
  if (platform !== "linux" || !sandboxed) return tempDir;
  const candidates = [runnerTemp, tempDir, join(cwd, ".fr")].filter((path): path is string => typeof path === "string" && isAbsolute(path));
  const base = candidates.find(path => outsideLinuxPrivateMounts(path) && Buffer.byteLength(join(path, "fr-XXXXXX", "s", DELIVERY_READ_SOCKET_NAME)) <= 103);
  if (!base) throw new Error(`Sandboxed Linux delivery read fixture requires a base outside private mounts with socket paths at most 103 bytes; candidate lengths: ${candidates.map(path => Buffer.byteLength(join(path, "fr-XXXXXX", "s", DELIVERY_READ_SOCKET_NAME))).join(", ")}`);
  return base;
}
