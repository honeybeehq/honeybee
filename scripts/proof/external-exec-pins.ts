import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { externalConfig } from "../../v2/core/src/externalExec.ts";
import { verifyBridge } from "../../v2/driver-hsr/src/externalBridge.ts";

const config = externalConfig(JSON.parse(readFileSync(process.argv[2]!, "utf8")).externalExec);
const registration = config.bridges["urbench-v2"];
assert.ok(registration);
const verified = verifyBridge({ registration }); verified.close();
for (const key of ["executableSha256", "filesManifestSha256", "payloadManifestSha256"] as const) {
  assert.throws(() => verifyBridge({ registration: { ...registration, [key]: "0".repeat(64) } }));
}
process.stdout.write(`${JSON.stringify({ bridgeId: "urbench-v2", hashVerifyBeforeExec: "all-three-pins-match", mismatches: "all-three-refused", executable: registration.executable, executableSha256: registration.executableSha256, filesManifestSha256: registration.filesManifestSha256, payloadManifestSha256: registration.payloadManifestSha256, executed: false })}\n`);
