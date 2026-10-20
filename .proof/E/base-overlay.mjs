import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const files = ["v2/core/src/accountAllocation.ts", "v2/core/src/store.ts", "v2/core/src/types.ts", "v2/daemon/src/accountsService.ts", "v2/daemon/src/daemon.ts", "v2/daemon/src/loops.ts"];
const sources = new Map(files.map(path => [new URL(path, `file://${repo}`).href, execFileSync("git", ["-C", repo, "show", `2191550f8514d0c5a81e21430189279ebad575e3:${path}`], { encoding: "utf8" })]));
registerHooks({ load(url, context, next) { const result = next(url, context); return sources.has(url) ? { ...result, source: sources.get(url) } : result; } });
