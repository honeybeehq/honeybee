import fs from "node:fs";
import { syncBuiltinESMExports, registerHooks } from "node:module";
import { resolve, relative } from "node:path";
const root = resolve(process.env.TMPDIR);
const trash = resolve(root, "trash");
fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
let count = 0;
fs.rmSync = function(path, options) {
  const target = resolve(String(path));
  if ((relative(root, target).startsWith("..") && relative(resolve(process.env.HOME), target).startsWith("..")) || target === root) throw new Error("cleanup outside lab root refused");
  if (!fs.existsSync(target)) return;
  fs.renameSync(target, resolve(trash, `${process.pid}-${++count}`));
};
syncBuiltinESMExports();
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith("/v2/daemon/tests/helpers.ts")) {
    result.source = String(result.source).replace("cleanup: () => rmSync(dir, { recursive: true, force: true }),", "cleanup: () => { renameSync(dir, dir + '-trashed'); },").replace("import { mkdirSync,", "import { renameSync, mkdirSync,");
  }
  if (url.endsWith("/v2/daemon/src/quotaRecovery.ts") && process.env.B_QUOTA_PAUSE_PATH) {
    result.source = 'import { existsSync as quotaGateExists } from "node:fs";\n' + String(result.source).replace('  reconcile(): void {', '  reconcile(): void { if (quotaGateExists(process.env.B_QUOTA_PAUSE_PATH!)) return;');
  }
  return result;
}});
