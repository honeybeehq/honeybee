import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DeliveryFiles, MULTILINE_FILE_MAX_BYTES } from "../src/deliveryFile.ts";
const owner="owner", bee="bee";
before(() => execFileSync(process.execPath,["scripts/build-delivery-file.mjs"],{stdio:"pipe"}));
function fixture() {
 const root=mkdtempSync(join(tmpdir(),"delivery-file-"));
 return {root,files:new DeliveryFiles(),id:randomUUID(),close:()=>rmSync(root,{recursive:true,force:true})};
}
function code(expected:string){return (e:unknown)=>e instanceof Error && "code" in e && e.code===expected;}
test("secure file publication preserves bytes, permissions, and idempotent inode", t=>{
 const f=fixture();t.after(f.close);
 const text="Paired-phone message — human approval not verified\n<apiary-phone-unverified encoding=escaped-text-v1>\n&amp;雪😀\n</apiary-phone-unverified>\nPaired-phone message — human approval not verified";
 const row=f.files.publish(f.root,owner,bee,f.id,text,[]);
 assert.deepEqual(readFileSync(row.path),Buffer.from(text));assert.equal(row.digest,createHash("sha256").update(text).digest("hex"));
 assert.equal(statSync(row.path).mode&0o777,0o600);assert.equal(statSync(dirname(row.path)).mode&0o777,0o700);assert.equal(statSync(dirname(dirname(row.path))).mode&0o777,0o700);
 const before=statSync(row.path);assert.deepEqual(f.files.publish(f.root,owner,bee,f.id,text,[]),row);const after=statSync(row.path);assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
 assert.throws(()=>f.files.publish(f.root,owner,bee,f.id,"different",[]),code("delivery_file_conflict"));assert.deepEqual(readFileSync(row.path),Buffer.from(text));
 f.files.remove(f.root,owner,bee,f.id);assert.equal(existsSync(row.path),false);f.files.remove(f.root,owner,bee,f.id);
});
test("file bytes are bounded before native publication",t=>{
 const f=fixture();t.after(f.close);const text="x".repeat(MULTILINE_FILE_MAX_BYTES);
 const row=f.files.publish(f.root,owner,bee,f.id,text,[]);assert.equal(statSync(row.path).size,MULTILINE_FILE_MAX_BYTES);
 assert.throws(()=>f.files.publish(f.root,owner,bee,randomUUID(),text+"x",[]),code("delivery_file_too_large"));
});
test("sender strings cannot enter the path and separate bees never share files",t=>{
 const f=fixture();t.after(f.close);const a=f.files.publish(f.root,"../sender\n", "../../bee",f.id,"one",[]);const b=f.files.publish(f.root,owner,bee,f.id,"two",[]);
 assert.match(a.path,new RegExp("/delivery-content/[a-f0-9]{64}/"+f.id+"\\.txt$"));assert.notEqual(a.path,b.path);assert.equal(readFileSync(b.path,"utf8"),"two");
});
for(const kind of ["root","ancestor","content","bee","file"])test(`symlink ${kind} is rejected without touching its target`,t=>{
 const f=fixture();t.after(f.close);const target=join(f.root,"target");mkdirSync(target,{mode:0o700});const marker=join(target,"marker");writeFileSync(marker,"untouched",{mode:0o600});
 if(kind==="root"||kind==="ancestor") {
 const alias=join(f.root,"alias");symlinkSync(target,alias);const root=kind==="root"?alias:join(alias,"child");if(kind==="ancestor")mkdirSync(join(target,"child"));
 assert.throws(()=>f.files.publish(root,owner,bee,f.id,"payload",[]),code("delivery_file_symlink_root"));
 }else{
 const directory=createHash("sha256").update(JSON.stringify([owner,bee])).digest("hex");const content=join(f.root,"delivery-content"),perBee=join(content,directory);
 if(kind==="content")symlinkSync(target,content);else{mkdirSync(content,{mode:0o700});if(kind==="bee")symlinkSync(target,perBee);else{mkdirSync(perBee,{mode:0o700});symlinkSync(marker,join(perBee,f.id+".txt"));}}
 assert.throws(()=>f.files.publish(f.root,owner,bee,f.id,"payload",[]),code(kind==="file"?"delivery_file_conflict":"delivery_file_directory"));
 }
 assert.equal(readFileSync(marker,"utf8"),"untouched");assert.deepEqual(requireEntries(target),kind==="ancestor"?["child","marker"]:["marker"]);
});
import { readdirSync } from "node:fs";
function requireEntries(path:string){return readdirSync(path).sort();}
for(const kind of ["directory-mode","file-mode","file-directory"])test(`unsafe existing ${kind} is refused`,t=>{
 const f=fixture();t.after(f.close);const row=f.files.publish(f.root,owner,bee,f.id,"content",[]);
 if(kind==="directory-mode")chmodSync(dirname(row.path),0o755);else if(kind==="file-mode")chmodSync(row.path,0o644);else{rmSync(row.path);mkdirSync(row.path,{mode:0o700});}
 assert.throws(()=>f.files.publish(f.root,owner,bee,f.id,"content",[]),code(kind==="directory-mode"?"delivery_file_directory":"delivery_file_conflict"));
});
test("writer refuses worktree paths, control characters and missing helper",t=>{
 const f=fixture();t.after(f.close);
 assert.throws(()=>f.files.publish(f.root,owner,bee,f.id,"content",[f.root]),code("delivery_file_inside_worktree"));
 assert.throws(()=>f.files.publish(f.root+"\n",owner,bee,f.id,"content",[]),code("delivery_file_location_invalid"));
 assert.throws(()=>f.files.publish(f.root,owner,bee,"../wrong","content",[]),code("delivery_file_location_invalid"));
 assert.throws(()=>new DeliveryFiles(join(f.root,"missing")).publish(f.root,owner,bee,f.id,"content",[]),code("delivery_file_helper_unavailable"));
});
