// Force the exit callback to be the first consumer of final runner status.
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/v2/driver-hsr/src/driver.ts")) return result;
    let source = String(result.source);
    const ordinary = "this.pumpStatus(p);";
    if (source.split(ordinary).length !== 3) throw new Error("status pump fixture no longer matches source");
    source = source.replaceAll(ordinary, "void p;");
    if (process.env.HIVE_TEST_OLD_FINISH_HOST === "1") {
      const final = "this.pumpStatus(p, true);";
      if (!source.includes(final)) throw new Error("final status fixture no longer matches source");
      source = source.replace(final, "void p;");
    }
    return { ...result, source };
  },
});
