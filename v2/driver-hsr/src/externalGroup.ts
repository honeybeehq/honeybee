import { readdirSync, readFileSync } from "node:fs";
import { inspectProcess, sameProcess, type ProcessIdentity } from "./psutil.ts";

function members(pgid: number): {identities: ProcessIdentity[]; observed: boolean} {
  const result: ProcessIdentity[] = [];
  let observed = false;
  for (const name of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== pgid || fields[0] === "Z") continue;
      observed = true;
    } catch {continue;}
    const value = inspectProcess(Number(name));
    if (value.kind === "present" && value.pgid === pgid && value.state === "live") result.push({pid: value.pid, birth: value.birth, bootId: value.bootId});
  }
  return {identities: result, observed};
}
export function externalGroupStop(identity: ProcessIdentity, graceMs: number, uncertain: () => void, done: () => void): {kill(): void} {
  const leader = inspectProcess(identity.pid);
  if (!sameProcess(identity, leader) || leader.pgid !== identity.pid) throw new Error("external_exec_group_identity_unavailable");
  const pgid = identity.pid;
  let anchors = members(pgid).identities;
  const confirmed = inspectProcess(identity.pid);
  if (!sameProcess(identity, confirmed) || confirmed.pgid !== pgid || confirmed.state !== "live") throw new Error("external_exec_group_identity_unavailable");
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  const signal = (kind: "SIGTERM" | "SIGKILL") => {
    const anchor = anchors.find(item => { const value = inspectProcess(item.pid); return sameProcess(item, value) && value.state === "live" && value.pgid === pgid; });
    if (!anchor) {
      if (members(pgid).observed) {uncertain(); return "unknown";}
      return "empty";
    }
    const discovered = members(pgid).identities;
    const value = inspectProcess(anchor.pid);
    if (!sameProcess(anchor, value) || value.pgid !== pgid) {uncertain(); return "unknown";}
    anchors = discovered;
    try {process.kill(-pgid, kind); return "signaled";} catch (error) {if ((error as NodeJS.ErrnoException).code === "ESRCH") return "empty"; uncertain(); return "unknown";}
  };
  const finishKill = () => {
    cancel();
    if (signal("SIGKILL") === "unknown") {timer = setTimeout(finishKill, Math.max(graceMs, 1000)); timer.unref();}
    else done();
  };
  timer = setTimeout(() => {
    timer = null;
    if (signal("SIGTERM") === "empty") {done(); return;}
    uncertain();
    timer = setTimeout(finishKill, graceMs); timer.unref();
  }, graceMs); timer.unref();
  return {kill: finishKill};
}
