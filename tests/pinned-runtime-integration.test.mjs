import { tsImport } from "tsx/esm/api";

await tsImport("./deploy-gate-env.test.ts", import.meta.url);
await tsImport("./deploy-restart.test.ts", import.meta.url);
await tsImport("./deploy-runtime.test.ts", import.meta.url);
await tsImport("./deploy-cli.test.ts", import.meta.url);
await tsImport("./deploy-artifact.test.ts", import.meta.url);
