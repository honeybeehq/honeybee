import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const files = execFileSync("git", ["diff", "--name-only", "3c562377", "HEAD", "--", "v2"], { encoding: "utf8", cwd: root }).trim().split("\n").filter(path => path.includes("/src/") && path.endsWith(".ts"));
const sources = new Map(files.map(path => [pathToFileURL(resolve(root, path)).href, execFileSync("git", ["show", `3c562377:${path}`], { encoding: "utf8", cwd: root })]));
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (sources.has(url)) result.source = sources.get(url);
  return result;
} });
