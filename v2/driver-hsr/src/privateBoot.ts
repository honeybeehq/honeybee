export const PRIVATE_BOOT_ENCODED_MAX_BYTES = 12 * (2 * 1024 * 1024 + 16384);
export function decodePrivateBoot(bytes: Buffer): string[] {
  try {
    if (bytes.length > PRIVATE_BOOT_ENCODED_MAX_BYTES) throw new Error("Private boot too large");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") throw new Error("Invalid private boot");
    return value;
  } finally {bytes.fill(0);}
}
