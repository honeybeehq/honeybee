import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
const root = resolve(".");
const files = new Set(["v2/core/src/types.ts", "v2/core/src/schema.ts", "v2/core/src/store.ts", "v2/core/src/audit.ts", "v2/core/src/quota.ts", "v2/daemon/src/daemon.ts", "v2/daemon/src/loops.ts", "v2/daemon/src/protocol.ts", "v2/driver-hsr/src/driver.ts"]);
registerHooks({ load(url, context, next) {
  const path = url.startsWith("file:") ? relative(root, fileURLToPath(url)) : "";
  if (files.has(path)) return { format: "module-typescript", source: execFileSync("git", ["show", `4db4790d89070abfb44c4ca2ce23fc8331416aca:${path}`], { encoding: "utf8" }), shortCircuit: true };
  return next(url, context);
}});
