import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
const root = resolve(process.env.PROOF_CELL);
const trash = join(root, ".proof/D/trash");
fs.mkdirSync(trash, { recursive: true });
function move(path, options = {}) {
  const target = resolve(String(path));
  if (!target.startsWith(root + "/") && !target.startsWith(process.env.PROOF_RUN_ROOT + "/")) throw new Error("trash outside owned Cell refused");
  try { fs.renameSync(target, join(trash, randomUUID())); }
  catch (e) { if (e.code !== "ENOENT" || !options.force) throw e; }
}
fs.rmSync = move;
fsp.rm = async (path, options) => move(path, options);
syncBuiltinESMExports();
