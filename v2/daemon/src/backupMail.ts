/** Bounded SMTP transport. Credentials exist only in this call and the TLS stream. */
import { connect as connectNet, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { createHash } from "node:crypto";
import type { BackupServiceAlert } from "../../core/src/backupService.ts";
export interface BackupMailConfig {host:string;port:number;secure:boolean;recipientRef:string;credentialRef:string}
export type BackupSecretResolver=(ref:string,field:string)=>Promise<string>;
export class BackupMailError extends Error {constructor(){super("mail_failed");}}
const mailbox=(value:string)=>/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(value)&&value.length<255;
export async function sendBackupAlert(config:BackupMailConfig,alert:BackupServiceAlert,resolveSecret:BackupSecretResolver):Promise<void>{
 if(!/^global\/fleet-backup-alert-[A-Za-z0-9._-]+$/.test(config.recipientRef)||!/^global\/fleet-backup-mail-[A-Za-z0-9._-]+$/.test(config.credentialRef)||!Number.isSafeInteger(config.port)||config.port<1||config.port>65535||(!config.secure&&!['127.0.0.1','::1'].includes(config.host)))throw new BackupMailError();
 let recipient:string,user:string,password:string,from:string;
 try{[recipient,user,password,from]=await Promise.all([resolveSecret(config.recipientRef,'address'),resolveSecret(config.credentialRef,'username'),resolveSecret(config.credentialRef,'password'),resolveSecret(config.credentialRef,'from')]);if(!mailbox(recipient)||!mailbox(from)||/[\r\n\0]/.test(user+password)||!user||!password)throw 0;}catch{throw new BackupMailError();}
 const socket:Socket=config.secure?connectTls({host:config.host,port:config.port,servername:config.host,rejectUnauthorized:true}):connectNet({host:config.host,port:config.port});
 const responses:{code:number}[]=[],waiters:{resolve:(code:number)=>void;reject:()=>void}[]=[];let bytes=0,buffer='',failed=false;
 const failure=()=>{failed=true;for(const waiter of waiters.splice(0))waiter.reject();socket.destroy();};
 socket.setTimeout(15000,failure);socket.on('error',failure);socket.on('close',failure);
 socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){failure();return;}buffer+=chunk.toString('utf8');if(buffer.length>8192){failure();return;}for(let n;(n=buffer.indexOf('\r\n'))>=0;){const line=buffer.slice(0,n);buffer=buffer.slice(n+2);if(!/^\d{3}[ -]/.test(line)){failure();return;}if(line[3]==='-')continue;const code=Number(line.slice(0,3)),waiter=waiters.shift();if(waiter)waiter.resolve(code);else responses.push({code});}});
 const response=()=>new Promise<number>((resolve,reject)=>{if(failed){reject(new BackupMailError());return;}const row=responses.shift();if(row)resolve(row.code);else waiters.push({resolve,reject:()=>reject(new BackupMailError())});});
 const command=async(text:string,expected:number[])=>{if(text.length>8192)throw new BackupMailError();socket.write(text+'\r\n');const code=await response();if(!expected.includes(code))throw new BackupMailError();};
 try{
  if(await response()!==220)throw new BackupMailError();await command('EHLO honeybee-backup',[250]);
  await command('AUTH PLAIN '+Buffer.from('\0'+user+'\0'+password).toString('base64'),[235]);await command('MAIL FROM:<'+from+'>',[250]);await command('RCPT TO:<'+recipient+'>',[250,251]);await command('DATA',[354]);
  // No source paths, URLs, credentials or raw exception/tool output belong in email.
  const machine=alert.machine.replace(/[^A-Za-z0-9._-]/g,'?').slice(0,128),code=alert.code;
  const id=createHash('sha256').update(alert.messageId).digest('hex');
  const body=['From: '+from,'To: '+recipient,'Subject: Honeybee backup '+code,'Message-ID: <'+id+'@honeybee-backup.invalid>','Date: '+new Date(alert.createdAt).toUTCString(),'MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','','Backup monitoring: '+code,'Machine: '+machine,'Inspect the owner backup status for details.'];
  await command(body.map(line=>line.startsWith('.')?'.'+line:line).join('\r\n')+'\r\n.',[250]);await command('QUIT',[221]);socket.end();
 }catch{throw new BackupMailError();}finally{socket.destroy();}
}
