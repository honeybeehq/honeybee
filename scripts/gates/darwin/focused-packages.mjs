import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(process.cwd());
const modules = join(root, 'node_modules');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const inside = path => path.startsWith(modules + sep) && realpathSync(path) === path;
const rows = [];
for (const specifier of ['ajv/dist/2020.js', 'jsonc-parser', 'smol-toml']) {
  const packageName = specifier === 'ajv/dist/2020.js' ? 'ajv' : specifier;
  const packageJson = join(modules, packageName, 'package.json');
  if (!inside(packageJson)) throw new Error('Package metadata escapes node_modules');
  const data = JSON.parse(readFileSync(packageJson, 'utf8'));
  if (data.name !== packageName || typeof data.version !== 'string') throw new Error('Wrong package identity');
  const entry = fileURLToPath(import.meta.resolve(specifier));
  if (!inside(entry)) throw new Error('Package entry escapes pinned node_modules');
  rows.push({specifier, path: relative(root, entry), version: data.version, packageJson: relative(root, packageJson), packageJsonSha256: hash(packageJson), entrySha256: hash(entry)});
}
process.stdout.write(JSON.stringify(rows) + '\n');
