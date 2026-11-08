// A successful adoption does not make a later native identity observation
// infallible. Refuse exactly one shutdown signal, without weakening its fence.
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    let source = String(result.source);
    if (url.endsWith("/v2/daemon/src/daemon.ts") && process.env.HIVE_TEST_OLD_DISPOSAL === "1") {
      const marker = "await this.driver?.disposeAllAndWait();";
      if (!source.includes(marker)) throw new Error("old disposal fixture no longer matches source");
      return { ...result, source: source.replace(marker, "this.driver?.disposeAll();") };
    }
    if (!url.endsWith("/v2/driver-hsr/src/driver.ts")) return result;
    const shutdown = "disposeAll(): void {";
    const fence = "if (!verifyProcessIdentity(p.pid, p.processIdentity ?? null)) return;";
    if (!source.includes(shutdown) || !source.includes(fence)) throw new Error("shutdown signal fixture no longer matches source");
    source = source.replace(shutdown, `${shutdown} this.__testDisposing = true;`);
    if (process.env.HIVE_TEST_SIGNAL_REFUSAL_MODE === "permanent") {
      const timeout = "disposeAllAndWait(timeoutMs = 15_000)";
      if (!source.includes(timeout)) throw new Error("disposal timeout fixture no longer matches source");
      source = source.replace(timeout, "disposeAllAndWait(timeoutMs = 100)");
    }
    source = source.replace(fence, `if (this.__testDisposing && process.env.HIVE_TEST_SIGNAL_REFUSAL_MODE !== "signal" && process.env.HIVE_TEST_SIGNAL_REFUSAL && (!existsSync(process.env.HIVE_TEST_SIGNAL_REFUSAL) || process.env.HIVE_TEST_SIGNAL_REFUSAL_MODE === "permanent")) { writeFileSync(process.env.HIVE_TEST_SIGNAL_REFUSAL, String(p.pid)); return; } ${fence}`);
    source = source.replaceAll('process.kill(-p.pid, signal);', `if (this.__testDisposing && process.env.HIVE_TEST_SIGNAL_REFUSAL_MODE === "signal" && !existsSync(process.env.HIVE_TEST_SIGNAL_REFUSAL)) { writeFileSync(process.env.HIVE_TEST_SIGNAL_REFUSAL, String(p.pid)); throw new Error("injected native signal failure"); } process.kill(-p.pid, signal);`);
    return { ...result, source };
  },
});
