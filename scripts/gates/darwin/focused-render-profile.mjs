import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const [workspace, root, profile, node, reader] = process.argv.slice(2);
const { wrapWithSandbox } = await import(pathToFileURL(resolve(workspace, 'v2/driver-cell/src/sandbox.ts')).href);
const policy = {cellDir: resolve(root, 'work'), writablePaths: [], scratchPaths: []};
const rendered = wrapWithSandbox(policy, node, [reader], profile, 'darwin');
if (rendered.command !== 'sandbox-exec' || JSON.stringify(rendered.args) !== JSON.stringify(['-f', profile, node, reader]) || typeof rendered.profile !== 'string') throw new Error('production renderer contract mismatch');
process.stdout.write(JSON.stringify({policy, profile: rendered.profile}));
