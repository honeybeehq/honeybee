import { tsImport } from "tsx/esm/api";

await tsImport("./apiary-swap.lab.ts", import.meta.url);
await tsImport("./canonical-json.test.ts", import.meta.url);
await tsImport("./release-contract.test.ts", import.meta.url);
await tsImport("./release-contract-v2.test.ts", import.meta.url);
await tsImport("./deploy-runtime.test.ts", import.meta.url);
await tsImport("./deploy-restart.test.ts", import.meta.url);
await tsImport("./deploy-artifact.test.ts", import.meta.url);
await tsImport("../v2/core/tests/update-reservation.test.ts", import.meta.url);
await tsImport("../v2/core/tests/apiary-swap.test.ts", import.meta.url);
await tsImport("../v2/daemon/tests/update-owner.test.ts", import.meta.url);
await tsImport("../v2/daemon/tests/local-rpc-trust.test.ts", import.meta.url);
