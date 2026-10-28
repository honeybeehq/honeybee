// An authenticated Apiary stand-in: only disposable test keys and harmless RPCs.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RpcClient } from '../../../cli/src/client.ts';
import { localTrustMessage } from '../../src/localRpcTrust.ts';
const root = process.argv[2];
const client = await RpcClient.connect(join(root, 'hived.sock'));
const challenge = await client.request('rpc.localTrust.challenge');
const key = readFileSync(join(root, 'rpc-private', 'registration.key'));
const token = createHmac('sha256', key).update(localTrustMessage(challenge)).digest('hex'); key.fill(0);
const registration = await client.request('rpc.localTrust.register', {pid:process.pid, challengeId:challenge.challengeId, token});
let mode = 'eligible', stopped = false;
const stop = () => { if (stopped) return; stopped = true; client.close(); process.disconnect?.(); };
process.on('disconnect', stop);
process.on('message', message => {
  if (message.stop) { stop(); return; }
  mode = message.mode; process.send?.({updated:true});
});
process.send?.({ready:true, registration});
try {
  while (!stopped) {
    const {queries} = await client.request('admission.eligibility.subscribe', {nodeId:'fixture-workstation', registrationEpoch:registration.registrationEpoch}, 35000);
    for (const query of queries) {
      if (mode === 'unreachable') continue;
      if (mode === 'disconnect') { stop(); break; }
      const {fields, operation, ...reply} = query;
      await client.request('admission.eligibility.answer', {...reply, eligible:mode === 'eligible', ...(mode === 'eligible' ? {satellite:{nodeId:'fixture-worker',name:'Fixture satellite'}} : {})});
    }
  }
} catch (error) { if (!stopped) { console.error(error); process.exitCode = 1; } }
client.close();
