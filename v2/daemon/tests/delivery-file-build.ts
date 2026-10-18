import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function ensureDeliveryFileArtifact(): void {
  const directory = new URL(`../../../dist/v2/delivery-file/${process.platform}-${process.arch}/`, import.meta.url);
  try {
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8"));
    const source = readFileSync(new URL("../native/delivery-file.c", import.meta.url));
    const binary = readFileSync(new URL("delivery-file.node", directory));
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    if (manifest.sourceSha256 === hash(source) && manifest.sha256 === hash(binary) && manifest.target === `${process.platform}-${process.arch}`) return;
  } catch {}
  if (process.env.SCG_DELIVERY_FILE_PREBUILT_ONLY === "1") throw new Error("prebuilt delivery helper required");
  execFileSync(process.execPath, ["scripts/build-delivery-file.mjs"], {stdio: "pipe"});
}
