import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { RpcClient } from "../../cli/src/client.ts";
import { waitFor } from "./helpers.ts";

export async function eligibilityPeer(t: TestContext, root: string, socketPath: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/eligibility-peer.mjs", import.meta.url)), root], {env:{...process.env},stdio:["ignore","ignore","pipe","ipc"]});
  let stderr = ""; child.stderr?.on("data", value => { stderr += value; });
  const ready = await Promise.race([once(child, "message"), once(child,"exit").then(() => { throw new Error(`Eligibility fixture exited: ${stderr}`); })]);
  if (!(ready[0] as {ready?:boolean}).ready) throw new Error("Eligibility fixture did not register");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null && child.connected) { const exited = once(child,"exit"); child.send({stop:true}); await exited; }
  });
  const observer = await RpcClient.connect(socketPath);
  await waitFor(async () => {
    const health = await observer.request<{workstationAdmission?:{eligibility?:{ready:boolean}}}>("health");
    return health.workstationAdmission?.eligibility?.ready;
  }, "eligibility subscription");
  observer.close();
  return { async mode(mode: "eligible" | "ineligible" | "unreachable" | "disconnect") { const ack = once(child,"message"); child.send({mode}); await ack; } };
}
