// Reproduce the old teardown ordering against the final regression fixture.
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/v2/daemon/tests/helpers.ts")) return result;
    const source = String(result.source);
    const begin = source.indexOf("        // Persisted idle does not prove survivor adoption.");
    const end = source.indexOf('        proc.kill("SIGTERM");', begin);
    if (begin < 0 || end < 0) throw new Error("original shutdown proof no longer matches helper source");
    return { ...result, source: source.slice(0, begin) + source.slice(end) };
  },
});
