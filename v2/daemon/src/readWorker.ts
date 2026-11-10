import { parentPort, workerData } from "node:worker_threads";
import { openCoreStore } from "../../core/src/index.ts";
import { inspectProcess } from "../../harness/src/processIdentity.ts";
import { ConfinedAdmission, assertConfinedVerb, classifyPeer, peerConfinement, peerOwner } from "./confinedPeer.ts";
import { IdentityRecovery } from "./identityRecovery.ts";
import { admitConfinedPeer, peerOwnerOf } from "./peerAuthority.ts";
import { RpcError } from "./protocol.ts";
import type { ReadWorkerCommand, ReadWorkerData, ReadWorkerEvent } from "./readServer.ts";
import { RpcServer, StoreRead, StoreReadFailure, assertLocalHandoffRpc } from "./rpc.ts";
import { READ_SOCKET_VERBS, StoreReads, isReadSocketVerb } from "./storeReads.ts";

if (!parentPort) throw new Error("readWorker runs as a worker thread");
const port = parentPort;
const data = workerData as ReadWorkerData;
const post = (event: ReadWorkerEvent): void => port.postMessage(event);

const store = openCoreStore(data.storePath, { readOnly: true });
const identity = new IdentityRecovery();
identity.replace(data.identity);
const admission = new ConfinedAdmission();
const reads = new StoreReads({ store: () => store, identity, transcriptStore: () => data.transcriptStore });
let strictConfinement = data.strictConfinement;

const server = new RpcServer({
  socketPath: data.socketPath,
  dataDir: data.dataDir,
  instance: data.instance,
  localTrust: data.localTrust,
  readSocket: () => data.socketPath,
  admitConfined: (verb, params, conn) => admitConfinedPeer(store, admission, verb, params, conn),
  classifyPeer: peer => classifyPeer(peer, { owner: () => peerOwnerOf(store, peer, inspectProcess) }),
  peerConfinement: (peerClass, registered) => peerConfinement(peerClass, { strict: strictConfinement, registered }),
  assertServiceCaller: (peerClass) => {
    if (peerOwner({ peerClass })) throw new RpcError("caller_not_trusted", "A bee runtime cannot register as the Apiary service");
  },
  securityAudit: (kind, payload) => post({ type: "audit", kind, payload }),
  log: op => post({ type: "log", op }),
  dispatch: (verb, params, conn) => {
    assertConfinedVerb(verb, conn.confinement ?? "unknown");
    assertLocalHandoffRpc(verb, params, conn);
    if (!isReadSocketVerb(verb)) throw new RpcError("invalid_request", `the read socket serves ${READ_SOCKET_VERBS.join(", ")}; use the main socket for ${verb}`);
    const { value, seq } = store.readAtSeq(() => {
      try { return { ok: true as const, result: reads.dispatch(verb, params, conn) }; }
      catch (error) { return { ok: false as const, error }; }
    });
    if (!value.ok) throw new StoreReadFailure(value.error, seq);
    return new StoreRead(value.result, seq);
  },
});

port.on("message", (command: ReadWorkerCommand) => {
  if (command.type === "confinement") strictConfinement = command.strict;
  else if (command.type === "identity") identity.replace(command.rows);
  else void server.close().finally(() => { store.close(); port.close(); });
});

server.listen().then(
  () => post({ type: "ready" }),
  (error: unknown) => {
    store.close();
    post({ type: "failed", message: error instanceof Error ? error.message : String(error) });
    port.close();
  },
);
