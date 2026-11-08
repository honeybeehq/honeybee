// Observe test-fixture exit latency without changing daemon behavior or bounds.
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/v2/daemon/tests/helpers.ts')) return result;
    let source = String(result.source);
    const start = '        proc.kill("SIGTERM");\n        await waitFor(() => proc.exitCode != null || proc.signalCode != null, "daemon stopped", opts.stopTimeoutMs ?? scaledMs(30_000));';
    if (!source.includes(start)) throw Error('shutdown timing probe source drift');
    source = source.replace(start, '        const exitStarted = performance.now();\n' + start + '\n        console.error(JSON.stringify({phase:"fixture-daemon-exit",elapsedMs:performance.now()-exitStarted}));');
    return {...result, source};
  }
});
