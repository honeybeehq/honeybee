import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve, relative, join } from "node:path";
const root = resolve(process.env.C_LAB_ROOT);
if (!root.startsWith("/var/tmp/hb-quota-C.")) throw new Error("isolated C lab root required");
const trash = join(root, "trash");
fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
let counter = 0;
fs.rmSync = function(path) {
  const target = resolve(String(path));
  if (target === root || relative(root, target).startsWith("..")) throw new Error("cleanup outside C lab refused");
  if (fs.existsSync(target)) fs.renameSync(target, join(trash, `${process.pid}-${++counter}`));
};
syncBuiltinESMExports();
