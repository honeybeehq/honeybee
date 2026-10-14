import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signalExitCode, terminateTestProcessTree } from "./test-process-control.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("usage: with-fixture-warden.mjs <command> [args...]");
const gateRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform === "win32") {
  const child = spawn(command, args, { stdio: "inherit" });
  child.once("exit", (code, signal) => process.exit(code ?? signalExitCode(signal)));
} else {
  const leaseDir = mkdtempSync(join(tmpdir(), "hive-fixture-lease-"));
  const warden = spawn(process.execPath, [join(gateRoot, "scripts", "fixture-warden.mjs"), String(process.pid), gateRoot, leaseDir], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const wardenGone = new Promise(resolveGone => warden.once("exit", () => resolveGone(null)));
  const nextMessage = type => Promise.race([
    new Promise(resolveMessage => warden.on("message", message => { if (message?.type === type) resolveMessage(message); })),
    wardenGone,
  ]);
  if (await nextMessage("ready") === null) throw new Error("fixture warden exited before it was ready");

  let sweep;
  const sweepFixtures = () => {
    sweep ??= (async () => {
      if (warden.connected) warden.send({ type: "sweep" });
      const report = await nextMessage("swept");
      for (const { pid, args: line } of report?.reaped ?? []) {
        console.error(`fixture-warden: reaped leaked fixture pid ${pid}: ${line}`);
      }
      if (warden.connected) warden.disconnect();
      rmSync(leaseDir, { recursive: true, force: true });
    })();
    return sweep;
  };

  const child = spawn(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    env: { ...process.env, HIVE_TEST_FIXTURE_LEASE: `${process.pid}:${leaseDir}` },
  });
  const adopted = nextMessage("adopted");
  if (child.pid !== undefined) warden.send({ type: "adopt", pid: child.pid });

  let requestedSignal;
  const onSignal = signal => {
    if (requestedSignal) return;
    requestedSignal = signal;
    void terminateTestProcessTree(child, signal).finally(() => sweepFixtures()).then(() => process.exit(signalExitCode(signal)));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, onSignal);
  const launcherPid = process.ppid;
  setInterval(() => { if (process.ppid !== launcherPid) onSignal("SIGTERM"); }, 250).unref();

  const result = await new Promise(resolveExit => {
    child.once("error", error => resolveExit({ error }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  await adopted;
  if (requestedSignal) await new Promise(() => undefined);
  await sweepFixtures();
  if (result.error) throw result.error;
  process.exit(result.code ?? signalExitCode(result.signal));
}
