#!/usr/bin/env node
// Build one release-like runtime artifact plus identity/admission JSON for the
// deploy --artifact byte-compare. Usage: node make-fixture.mjs <runtimeArtifact module> <out dir>
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [moduleArg, outArg] = process.argv.slice(2);
if (!moduleArg || !outArg) throw new Error("usage: make-fixture.mjs <runtimeArtifact module> <out dir>");
const { packRuntimeArtifact, sha256File } = await import(pathToFileURL(resolve(moduleArg)).href);
const out = resolve(outArg);
await rm(out, { recursive: true, force: true });
const sha = "f".repeat(40);
const target = `${process.platform}-${process.arch}`;
const stage = join(out, "stage");
await mkdir(join(stage, "dist", "v2"), { recursive: true });
// The artifact's own CLI answers the deploy owner's service and identity verbs
// so the real restart path runs without a daemon or a service manager.
const fixtureCli = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const identity = JSON.parse(readFileSync(new URL("./build-identity.json", import.meta.url), "utf8"));
if (argv[0] === "v2" && argv[1] === "daemon" && argv[2] === "status" && argv.includes("--json")) { console.log(JSON.stringify({ running: true })); process.exit(0); }
if (argv[0] === "v2" && argv[1] === "daemon") process.exit(0);
if (argv[0] === "v2" && argv[1] === "deploy-info") { console.log(JSON.stringify({ pid: 4242, startedAt: 1, nodeVersion: process.version, identity })); process.exit(0); }
console.error("fixture cli: unsupported " + argv.join(" ")); process.exit(2);
`;
await writeFile(join(stage, "dist", "cli.js"), fixtureCli);
await writeFile(join(out, "fixture-cli.js"), fixtureCli);
await writeFile(join(stage, "dist", "v2", "cli.js"), `var SCHEMA_VERSION = 48;\nvar PROTOCOL = "v2/2";\nvar UPDATE_RECOVERY_CONTRACT = "honeybee-v27-disabled-authority-v1";\nprocess.exit(1);\n`);
await writeFile(join(stage, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1,
  component: "honeybee", version: "0.1.0", packageVersion: "0.1.0", sourceRevision: sha,
  dirty: false, release: true, target }));
await writeFile(join(stage, "package.json"), JSON.stringify({ name: "honeybee", version: "0.1.0", engines: { node: ">=24" } }));
await cp(join(process.cwd(), "contracts", "execution", "v1"), join(stage, "contracts", "execution", "v1"), { recursive: true });
await symlink("cli.js", join(stage, "dist", "hive"));
const packed = await packRuntimeArtifact({ artifactDir: stage, sha, outDir: join(out, "release"), gate: "full", now: () => new Date("2026-11-04T00:00:00.000Z") });
const digest = (await sha256File(packed.tarballPath)).sha256;
const identity = { component: "honeybee", version: "0.1.0", sourceRevision: sha, target, artifact: { url: "https://example.test/runtime.tgz", sha256: `sha256:${digest}` } };
await writeFile(join(out, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
await writeFile(join(out, "admission.json"), `${JSON.stringify({ fresh: true }, null, 2)}\n`);
await writeFile(join(out, "bad-identity.json"), `${JSON.stringify({ ...identity, artifact: { ...identity.artifact, sha256: `sha256:${"0".repeat(64)}` } }, null, 2)}\n`);
await rm(stage, { recursive: true, force: true });
console.log(JSON.stringify({ archive: packed.tarballPath, sha256: digest, sha }));
