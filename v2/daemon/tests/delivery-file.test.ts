import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeliveryFiles, MULTILINE_FILE_MAX_BYTES } from "../src/deliveryFile.ts";
const owner="owner", bee="bee";
before(() => execFileSync(process.execPath,["scripts/build-delivery-file.mjs"],{stdio:"pipe"}));
function fixture() {
 const root=realpathSync(mkdtempSync(join(tmpdir(),"delivery-file-")));
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
 f.files.remove(f.root,owner,bee,f.id,[]);assert.equal(existsSync(row.path),false);f.files.remove(f.root,owner,bee,f.id,[]);
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
test("cleanup validates UUID, canonical roots, and worktree exclusion",t=>{
 const f=fixture();t.after(f.close);
 const row=f.files.publish(f.root,owner,bee,f.id,"content",[]);
 assert.throws(()=>f.files.remove(f.root,owner,bee,"../wrong",[]),code("delivery_file_location_invalid"));
 assert.throws(()=>f.files.remove(f.root,owner,bee,f.id,[f.root]),code("delivery_file_inside_worktree"));
 const alias=join(f.root,"alias");symlinkSync(f.root,alias);
 assert.throws(()=>f.files.remove(alias,owner,bee,f.id,[]),code("delivery_file_symlink_root"));
 assert.equal(readFileSync(row.path,"utf8"),"content");
});
test("published content reconciles leftover partial stages durably",t=>{
 const f=fixture();t.after(f.close);
 const row=f.files.publish(f.root,owner,bee,f.id,"content",[]),stage=join(dirname(row.path),`.${f.id}.stage.123.1`);
 writeFileSync(stage,"partial",{mode:0o600});
 f.files.publish(f.root,owner,bee,f.id,"content",[]);
 assert.equal(existsSync(stage),false);assert.equal(readFileSync(row.path,"utf8"),"content");
 writeFileSync(stage,"untrusted",{mode:0o644});
 assert.throws(()=>f.files.publish(f.root,owner,bee,f.id,"content",[]),code("delivery_file_reconcile"));
 assert.equal(readFileSync(stage,"utf8"),"untrusted");
});
const binary=fileURLToPath(new URL(`../../../dist/v2/delivery-file/${process.platform}-${process.arch}/delivery-file.node`,import.meta.url));
const nativePublish='const [binary,root,bee,id,text="content"]=process.argv.slice(1);require(binary).publish(root,bee,id,Buffer.from(text));';
test("concurrent matching publishers converge without replacing the final inode",async t=>{
 const f=fixture();t.after(f.close);const directory=createHash("sha256").update(JSON.stringify([owner,bee])).digest("hex");
 await Promise.all(Array.from({length:8},()=>new Promise<void>((resolve,reject)=>{
 const child=spawn(process.execPath,["-e",nativePublish,binary,f.root,directory,f.id],{stdio:["ignore","pipe","pipe"]});let error="";
 child.stderr.on("data",bytes=>error+=bytes);child.once("error",reject);child.once("exit",status=>status===0?resolve():reject(new Error(error||`exit ${status}`)));
 })));
 const row=f.files.publish(f.root,owner,bee,f.id,"content",[]);
 assert.deepEqual(requireEntries(dirname(row.path)),[f.id+".txt"]);assert.equal(readFileSync(row.path,"utf8"),"content");
});
for(const mode of ["error","before","after"])for(const boundary of [1,2,3,4])test(`first publication fsync ${boundary} ${mode} recovers idempotently`,{skip:process.platform!=="linux"},t=>{
 const f=fixture();t.after(f.close);const shim=join(f.root,"fault.so");
 execFileSync("cc",["-shared","-fPIC","-Wall","-Wextra","-Werror",fileURLToPath(new URL("./fixtures/delivery-file-fault.c",import.meta.url)),"-ldl","-o",shim]);
 const directory=createHash("sha256").update(JSON.stringify([owner,bee])).digest("hex");
 const result=spawnSync(process.execPath,["-e",nativePublish,binary,f.root,directory,f.id],{env:{...process.env,LD_PRELOAD:shim,HB_FILE_ROOT:f.root,HB_FILE_OP:"fsync",HB_FILE_N:String(boundary),HB_FILE_MODE:mode},encoding:"utf8"});
 assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,mode==="error"?1:91);
 const row=f.files.publish(f.root,owner,bee,f.id,"content",[]),inode=statSync(row.path).ino;
 assert.equal(readFileSync(row.path,"utf8"),"content");assert.deepEqual(requireEntries(dirname(row.path)),[f.id+".txt"]);
 f.files.publish(f.root,owner,bee,f.id,"content",[]);assert.equal(statSync(row.path).ino,inode);
});
for(const operation of ["unlinkat","close"])test(`publication ${operation} error remains visible and retry reconciles stages`,{skip:process.platform!=="linux"},t=>{
 const f=fixture();t.after(f.close);const shim=join(f.root,"fault.so");
 execFileSync("cc",["-shared","-fPIC","-Wall","-Wextra","-Werror",fileURLToPath(new URL("./fixtures/delivery-file-fault.c",import.meta.url)),"-ldl","-o",shim]);
 const directory=createHash("sha256").update(JSON.stringify([owner,bee])).digest("hex");
 const result=spawnSync(process.execPath,["-e",nativePublish,binary,f.root,directory,f.id],{env:{...process.env,LD_PRELOAD:shim,HB_FILE_ROOT:f.root,HB_FILE_OP:operation,HB_FILE_N:operation==="close"?"3":"1",HB_FILE_MODE:"error"},encoding:"utf8"});
 assert.equal(result.error,undefined);assert.equal(result.status,1);
 const row=f.files.publish(f.root,owner,bee,f.id,"content",[]);
 assert.equal(readFileSync(row.path,"utf8"),"content");assert.deepEqual(requireEntries(dirname(row.path)),[f.id+".txt"]);
});
for(const mode of [0o700,0o755,0o720,0o702,0o1777])test(`accepting root mode ${mode.toString(8)} is checked natively`,t=>{
 const f=fixture();t.after(f.close);chmodSync(f.root,mode);
 if(mode&0o22)assert.throws(()=>f.files.publish(f.root,owner,bee,f.id,"content",[]),code("delivery_file_directory"));
 else assert.equal(readFileSync(f.files.publish(f.root,owner,bee,f.id,"content",[]).path,"utf8"),"content");
});
for(const operation of ["fstat","swap"])test(`native ${operation==="fstat"?"simulated foreign-owned root":"directory swap after link"} refuses publication`,{skip:process.platform!=="linux"},t=>{
 const f=fixture();t.after(f.close);const shim=join(f.root,"fault.so");
 execFileSync("cc",["-shared","-fPIC","-Wall","-Wextra","-Werror",fileURLToPath(new URL("./fixtures/delivery-file-fault.c",import.meta.url)),"-ldl","-o",shim]);
 const directory=createHash("sha256").update(JSON.stringify([owner,bee])).digest("hex");
 const result=spawnSync(process.execPath,["-e",nativePublish,binary,f.root,directory,f.id],{env:{...process.env,LD_PRELOAD:shim,HB_FILE_ROOT:f.root,HB_FILE_OP:operation,HB_FILE_N:"1",HB_FILE_MODE:"error"},encoding:"utf8"});
 assert.equal(result.error,undefined);assert.equal(result.status,1);assert.match(result.stderr,/delivery_file_(directory|publish)/);
 if(operation==="fstat")assert.equal(existsSync(join(f.root,"delivery-content")),false);
 else assert.equal(readFileSync(join(f.root,"detached",directory,f.id+".txt"),"utf8"),"content");
});
test("development scale: publication and retry with ten thousand retained files",t=>{
 const f=fixture();t.after(f.close);const row=f.files.publish(f.root,owner,bee,f.id,"content",[]),directory=dirname(row.path);
 for(let i=0;i<10000;i++)writeFileSync(join(directory,randomUUID()+".txt"),"retained",{mode:0o600});
 const publication:number[]=[],retry:number[]=[];
 for(let i=0;i<21;i++) {
 const id=randomUUID();let start=performance.now();f.files.publish(f.root,owner,bee,id,"content",[]);publication.push(performance.now()-start);
 start=performance.now();f.files.publish(f.root,owner,bee,id,"content",[]);retry.push(performance.now()-start);
 }
 const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[10],p95Ms:values[19],maxMs:values[20]};};
 console.log("development-only retained10000",JSON.stringify({publication:summary(publication),retry:summary(retry)}));
});
test("competing different-content publishers cannot replace the winning bytes",async t=>{
 const f=fixture();t.after(f.close);const directory=createHash("sha256").update(JSON.stringify([owner,bee])).digest("hex");
 const results=await Promise.all(["first","second"].map(text=>new Promise<{text:string;status:number|null}>((resolve,reject)=>{
 const child=spawn(process.execPath,["-e",nativePublish,binary,f.root,directory,f.id,text],{stdio:"ignore"});child.once("error",reject);child.once("exit",status=>resolve({text,status}));
 })));
 const winner=results.find(result=>result.status===0);assert.ok(winner);assert.equal(results.filter(result=>result.status===0).length,1);
 const path=join(f.root,"delivery-content",directory,f.id+".txt"),inode=statSync(path).ino;assert.equal(readFileSync(path,"utf8"),winner.text);
 f.files.publish(f.root,owner,bee,f.id,winner.text,[]);assert.equal(statSync(path).ino,inode);
});
test("remove racing a publication leaves either absent or complete content and retry converges",async t=>{
 const f=fixture();t.after(f.close);const directory=createHash("sha256").update(JSON.stringify([owner,bee])).digest("hex");
 const nativeRemove='const [binary,root,bee,id]=process.argv.slice(1);require(binary).remove(root,bee,id);';
 await Promise.all([nativePublish,nativeRemove].map(script=>new Promise<void>((resolve,reject)=>{
 const child=spawn(process.execPath,["-e",script,binary,f.root,directory,f.id],{stdio:"ignore"});child.once("error",reject);child.once("exit",status=>status===0||status===1?resolve():reject(new Error(`exit ${status}`)));
 })));
 const path=join(f.root,"delivery-content",directory,f.id+".txt");if(existsSync(path))assert.equal(readFileSync(path,"utf8"),"content");
 f.files.publish(f.root,owner,bee,f.id,"content",[]);assert.equal(readFileSync(path,"utf8"),"content");
 assert.deepEqual(requireEntries(dirname(path)),[f.id+".txt"]);
 f.files.remove(f.root,owner,bee,f.id,[]);assert.equal(existsSync(dirname(path)),false);
});
