import { tsImport } from "tsx/esm/api";

await tsImport("./guard-live-rpc.lab.ts", import.meta.url);
await tsImport("./deploy-runtime.test.ts", import.meta.url);
await tsImport("./deploy-artifact.test.ts", import.meta.url);
