import { AsyncLocalStorage } from "node:async_hooks";

export interface RpcCaller {
  transport: "local_unix";
  ingress: "local_unix" | "node_relay" | "remote";
  uid: number;
  pid: number;
  verb: string;
}
const context = new AsyncLocalStorage<RpcCaller | null>();
export function withRpcCaller<T>(caller: RpcCaller | null, work: () => T): T { return context.run(caller, work); }
export function withoutRpcCaller<T>(work: () => T): T { return context.run(null, work); }
export function currentRpcCaller(): RpcCaller | null { return context.getStore() ?? null; }
