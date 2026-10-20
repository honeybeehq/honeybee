import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
const main = execFileSync("git", ["show", "3c56237742491bfe4d686606ddd920870840020b:v2/daemon/src/accountsService.ts"], { encoding: "utf8" });
const begin = "  private localActivities(";
const end = "  private exhaustedAdmissionRetry(";
const method = main.slice(main.indexOf(begin), main.indexOf(end));
if (!method.includes("this.store.listBees()")) throw new Error("missing main full-roster implementation");
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith("/v2/daemon/src/accountsService.ts")) {
    const source = String(result.source);
    result.source = source.slice(0, source.indexOf(begin)) + method + source.slice(source.indexOf(end));
  }
  return result;
} });
