// Profiling-only entry. Production workers run directly without this wrapper.
import { Session } from 'node:inspector/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workerData } from 'node:worker_threads';

const session = new Session();
session.connect();
try {
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 1000 });
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.startSampling', { samplingInterval: 65536 });
  await session.post('Profiler.start');
  await import(pathToFileURL(workerData.perf.entry).href);
  const cpu = await session.post('Profiler.stop');
  const heap = await session.post('HeapProfiler.stopSampling');
  writeFileSync(join(workerData.perf.out, 'worker.cpuprofile'), JSON.stringify(cpu.profile));
  writeFileSync(join(workerData.perf.out, 'worker.heapprofile'), JSON.stringify(heap.profile));
} finally {
  session.disconnect();
}
