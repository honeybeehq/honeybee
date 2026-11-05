import { readFileSync, writeFileSync } from "node:fs";
import { signReleaseDescriptor } from "../../v2/core/src/release/descriptor.ts";
import { sha256File } from "../../v2/core/src/release/runtimeArtifact.ts";
const [archive, keyPath, outBase, ...overrides] = process.argv.slice(2);
if (!archive || !keyPath || !outBase) throw new Error("usage: sign.mjs <archive> <private-key> <out-base> [field=value ...]");
const identity = JSON.parse(readFileSync(process.env.BUILD_IDENTITY_JSON, "utf8"));
const digest = await sha256File(archive);
const descriptor = {
  schemaVersion: 1,
  identity: { component: "honeybee", version: identity.version, sourceRevision: identity.sourceRevision, target: identity.target,
    artifact: { url: `https://releases.example.invalid/release-honeybee-${identity.sourceRevision}/honeybee-runtime-${identity.sourceRevision}.tar.gz`, sha256: `sha256:${digest.sha256}` } },
  engines: { node: ">=24 <25" },
  runNumber: 1,
  publishedAt: new Date().toISOString(),
};
for (const override of overrides) {
  const eq = override.indexOf("=");
  const path = override.slice(0, eq), value = override.slice(eq + 1);
  const keys = path.split(".");
  let node = descriptor;
  for (const key of keys.slice(0, -1)) node = node[key];
  node[keys.at(-1)] = value;
}
const signature = signReleaseDescriptor(descriptor, readFileSync(keyPath, "utf8"));
writeFileSync(`${outBase}.json`, `${JSON.stringify(descriptor, null, 2)}\n`);
writeFileSync(`${outBase}.json.sig`, `${JSON.stringify(signature)}\n`);
console.log(JSON.stringify({ out: `${outBase}.json`, sha256: digest.sha256, bytes: digest.bytes, keyId: signature.keyId }));
