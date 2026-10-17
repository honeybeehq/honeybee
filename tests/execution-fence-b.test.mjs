import { tsImport } from "tsx/esm/api";
await tsImport("../v2/core/tests/execution-spawn.test.ts",import.meta.url);
await tsImport("../v2/driver-hsr/tests/execution-handshake.test.ts",import.meta.url);
await tsImport("../v2/driver-cell/tests/fenced-provision.test.ts",import.meta.url);
await tsImport("../v2/daemon/tests/execution-fence.test.ts",import.meta.url);
