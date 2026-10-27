import { parentPort, workerData } from "node:worker_threads";
import { performVerifiedEviction, VerifiedEvictionError, type VerifiedEvictionInput } from "./verifiedEviction.ts";
parentPort!.once("message",()=>{
  try{parentPort!.postMessage({ok:true,result:performVerifiedEviction(workerData as VerifiedEvictionInput)});}
  catch(error){parentPort!.postMessage({ok:false,reason:error instanceof VerifiedEvictionError?error.reason:"outcome_unknown"});}
  finally{parentPort!.close();}
});
