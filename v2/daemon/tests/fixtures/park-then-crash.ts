import { openCoreStore } from "../../../core/src/index.ts";
import { CellRetentionService } from "../../src/cellRetention.ts";
import { defaultCellRetention } from "../../src/config.ts";

const [storePath, cellsRoot, cellId] = process.argv.slice(2) as [string, string, string];
const store = openCoreStore(storePath);
const original = store.evictCell.bind(store);
store.evictCell = ((id: string, input: Parameters<typeof original>[1]) => {
  if (id === cellId) {
    process.stdout.write(`parked ${id}; dying before the registry flips the row\n`);
    process.kill(process.pid, "SIGKILL");
  }
  return original(id, input);
}) as typeof original;
const service = new CellRetentionService({
  cellsRoot,
  policy: { ...defaultCellRetention("workstation"), stoppedAfterMs: 0, archivedAfterMs: 0, trimAfterMs: null, maxEvictionsPerDay: null },
  store: () => store,
  now: () => Date.now(),
  log: (op) => process.stdout.write(`${op}\n`),
  cellInUse: (_beeId, runtime) => runtime != null && runtime.state !== "stopped",
  opInFlight: () => false,
  forgetCell: () => undefined,
  statfs: () => ({ totalBytes: 1024 ** 4, freeBytes: 1024 ** 4 / 2 }),
});
await service.run({ dryRun: false, kind: "manual" });
process.stdout.write("pass ended without the crash\n");
await service.stop();
store.close();
process.exit(2);
