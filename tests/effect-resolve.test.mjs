import { tsImport } from "tsx/esm/api";
await tsImport("../v2/core/tests/effect-resolve.test.ts", import.meta.url);
await tsImport("../v2/daemon/tests/effect-resolve.test.ts", import.meta.url);
await tsImport("./effect-resolve.lab.ts", import.meta.url);
