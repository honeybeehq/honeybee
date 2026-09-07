import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const helperUrl = pathToFileURL(join(process.cwd(), "scripts", "rewrite-test-imports.mjs")).href;

async function rewrite(source: string, fileName = "fixture.ts"): Promise<string> {
  const loaded: unknown = await import(helperUrl);
  if (!loaded || typeof loaded !== "object") throw new Error("rewrite helper did not export a module");
  const candidate: unknown = Reflect.get(loaded, "rewriteRelativeTypeScriptImports");
  if (typeof candidate !== "function") throw new Error("rewrite helper export is not a function");
  const output: unknown = Reflect.apply(candidate, undefined, [source, fileName]);
  if (typeof output !== "string") throw new Error("rewrite helper returned a non-string");
  return output;
}

test("test-build import rewriting changes only relative literal TypeScript module specifiers", async () => {
  const source = [
    'import plain from "./plain.ts";',
    "export { named } from '../named.mts';",
    'export * from "./legacy.cts";',
    'const lazy = import("./lazy.ts");',
    'const escaped = import("./escaped\\u002ets");',
    'const template = import(`./template.mts`);',
    'const ordinary = "./ordinary.ts";',
    'const escapedOrdinary = "\\\"./quoted.ts\\\"";',
    'const asset = new URL("./asset.ts", import.meta.url);',
    'const computed = import("./" + name + ".ts");',
    'const remote = import("https://example.test/mod.ts");',
    'const packagePath = import("pkg/mod.ts");',
    'const declaration = import("./types.d.ts");',
    '// import("./comment.ts");',
  ].join("\n");

  assert.equal(await rewrite(source), [
    'import plain from "./plain.js";',
    'export { named } from "../named.mjs";',
    'export * from "./legacy.cjs";',
    'const lazy = import("./lazy.js");',
    'const escaped = import("./escaped.js");',
    'const template = import("./template.mjs");',
    'const ordinary = "./ordinary.ts";',
    'const escapedOrdinary = "\\\"./quoted.ts\\\"";',
    'const asset = new URL("./asset.ts", import.meta.url);',
    'const computed = import("./" + name + ".ts");',
    'const remote = import("https://example.test/mod.ts");',
    'const packagePath = import("pkg/mod.ts");',
    'const declaration = import("./types.d.ts");',
    '// import("./comment.ts");',
  ].join("\n"));
});

test("rewritten relative imports load as separate emitted ESM modules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-test-imports-"));
  try {
    const entry = await rewrite(
      'import { marker } from "./dependency.ts"; export const observed = marker;',
      join(dir, "entry.ts"),
    );
    await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
    await writeFile(join(dir, "entry.mjs"), entry);
    await writeFile(join(dir, "dependency.js"), 'export const marker = "loaded";\n');
    const loaded: unknown = await import(pathToFileURL(join(dir, "entry.mjs")).href);
    assert.ok(loaded && typeof loaded === "object");
    assert.equal(Reflect.get(loaded, "observed"), "loaded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
