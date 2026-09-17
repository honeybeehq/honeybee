import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build on the target OS/architecture, just like the native node-pty dependency.
// SDKROOT can select an installed SDK when the system default is incompatible
// with the installed linker. No compiler is needed at runtime.
export function buildProcessCensus(outDir) {
  if (process.platform !== 'darwin') return;
  mkdirSync(outDir, { recursive: true });
  const source = fileURLToPath(new URL('../native/process-census-darwin.c', import.meta.url));
  const target = join(outDir, 'process-census');
  const temp = `${target}.${process.pid}.tmp`;
  execFileSync('/usr/bin/xcrun', [
    'clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
    ...(process.env.SDKROOT ? ['-isysroot', process.env.SDKROOT] : []),
    source, '-o', temp,
  ], { stdio: 'inherit' });
  renameSync(temp, target);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildProcessCensus(fileURLToPath(new URL('../dist/native/', import.meta.url)));
}
