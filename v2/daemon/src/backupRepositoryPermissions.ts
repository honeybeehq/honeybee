/** Bounded permission preflight; the operator must migrate the entire ciphertext tree. */
import {access,lstat,opendir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {BackupServiceError} from './backupServiceSupport.ts';
export async function checkRepositoryPermissions(root:string):Promise<void>{
 try{
  const base=await lstat(root);
  const check=async(path:string,directory:boolean)=>{const st=await lstat(path);if(st.isSymbolicLink()||st.gid!==base.gid||!((directory&&st.isDirectory()&&(st.mode&0o7777)===0o2770)||(!directory&&st.isFile()&&(st.mode&0o7777)===0o660)))throw 0;await access(path,constants.R_OK|constants.W_OK|(directory?constants.X_OK:0));};
  await check(root,true);
  for(const name of['keys','locks','snapshots','index','data']){
   const directory=join(root,name);await check(directory,true);let count=0,packs=0;
   for await(const item of await opendir(directory)){
    const path=join(directory,item.name);
    if(name==='data'){
     if(++count>256||!/^[a-f0-9]{2}$/.test(item.name))throw 0;
     await check(path,true);
     if(packs<16)for await(const entry of await opendir(path)){if(++packs>16)break;await check(join(path,entry.name),false);}
    }else{if(++count>8)break;await check(path,false);}
   }
  }
 }catch{throw new BackupServiceError('permissions_invalid');}
}
