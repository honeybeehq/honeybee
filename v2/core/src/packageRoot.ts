import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedRoot: string | undefined;

/** The honeybee package directory this module runs from: the repo in source mode, the installed version in a build. */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try { if (JSON.parse(readFileSync(manifest, "utf8")).name === "honeybee") return cachedRoot = dir; } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("honeybee package root not found");
    dir = parent;
  }
}

/** The dist directory when this module runs from a build; undefined in source mode. */
export function distDirectory(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (basename(dir) === "dist") return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
