// Keep recovery pending until the owning test releases it. Do not eagerly
// import daemon modules: platform simulation must run before their evaluation.
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/v2/driver-hsr/src/driver.ts")) return result;
    const marker = "if (pid <= 0) return false;";
    const source = String(result.source);
    if (!source.includes(marker)) throw new Error("runner adoption fixture no longer matches source");
    return { ...result, source: source.replace(marker,
      `if (process.env.HIVE_TEST_ADOPTION_RELEASE && !existsSync(process.env.HIVE_TEST_ADOPTION_RELEASE)) return false; ${marker}`) };
  },
});
