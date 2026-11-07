// Reproduce against the helper from the task's immutable starting commit.
// Only the loaded helper source changes; no checkout files or runtime do.
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
const target = new URL('../../v2/daemon/tests/helpers.ts', import.meta.url).href;
registerHooks({ load(url, context, next) {
  if (url !== target) return next(url, context);
  const original = execFileSync('git', ['show', '8f5456e45ecdbc01c5a8b435b9735cbba55bb9eb:v2/daemon/tests/helpers.ts'], { encoding: 'utf8', cwd: new URL('../../', import.meta.url) });
  return { format: 'module-typescript', source: original, shortCircuit: true };
} });
