// A hostname can change with macOS network configuration during one capture run.
// Hash the OS boot identifier so separate captures can prove the same OS boot
// without publishing the underlying identifier. Unsupported hosts stay strict
// on hostname; this helper never synthesizes a stable identifier.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function bootIdentity() {
  let value, method;
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) return null;
    value = result.stdout.trim(); method = 'darwin-kern.bootsessionuuid-sha256';
  } else if (process.platform === 'linux') {
    try { value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
    catch { return null; }
    method = 'linux-boot-id-sha256';
  } else return null;
  if (!/^[a-f0-9-]{36}$/i.test(value)) return null;
  return { method, sha256: createHash('sha256').update(value.toLowerCase()).digest('hex') };
}
