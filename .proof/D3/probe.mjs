import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
const root = resolve(process.env.D2_ROOT);
const home = resolve(process.env.HOME);
if (!home.startsWith(root + "/")) throw new Error("D2 HOME outside isolated root");
const vendor = join(home, ".codex");
fs.mkdirSync(vendor, { recursive: true, mode: 0o700 });
if (process.env.D2_READONLY_CODEX === "1") {
 if (!fs.existsSync(join(vendor, "gate-sentinel"))) fs.writeFileSync(join(vendor, "gate-sentinel"), "synthetic read-only Codex fixture\n", {mode:0o400});
 fs.chmodSync(vendor, 0o500);
 let blocked = false;
 try { fs.writeFileSync(join(vendor, "write-probe"), "fixture"); } catch (e) { blocked = e.code === "EACCES" || e.code === "EROFS"; }
 if (!blocked) throw new Error("D2 fake vendor home is writable");
}
const record = value => fs.appendFileSync(process.env.D2_FS_LOG, JSON.stringify(value)+"\n");
record({pid:process.pid,home,vendor,mode:fs.statSync(vendor).mode & 0o777,readOnly:process.env.D2_READONLY_CODEX === "1"});
const trash = join(root, "trash");
function move(path, options = {}) {
 const target = resolve(String(path));
 if (!target.startsWith(root + "/")) throw new Error("D2 cleanup outside fixture refused");
 try { fs.renameSync(target, join(trash, randomUUID())); } catch(e) { if(e.code!=="ENOENT" || !options.force) throw e; }
}
fs.rmSync = move;
fsp.rm = async (path, options) => move(path, options);
syncBuiltinESMExports();
