import json
import os
from pathlib import Path

import focused_native


class Trace:
    def __init__(self, root, workspace, node, audit, native):
        self.read_fd, self.write_fd = os.pipe()
        os.set_blocking(self.read_fd, False)
        self.records = []
        self.buffer = b''
        self.total = 0
        self.root_pid = None
        self.node_pids = set()
        preloader = workspace / 'scripts/gates/darwin/focused-preload.mjs'
        artifacts = {}
        for kind, state in native.items():
            path = workspace / 'dist/v2' / kind / 'darwin-arm64' / (kind + '.node')
            info = state['files'][str(path.relative_to(root))]
            artifacts[str(path)] = {'sha256': info['sha256'], 'inode': str(info['ino']), 'mtimeNs': str(info['mtimeNs'])}
        self.policy = {'root': str(root), 'node': node, 'preloader': str(preloader), 'preloaderSha256': focused_native.digest(preloader), 'files': [str(workspace / row['path']) for row in audit['files'] if row['siblingClosure']], 'modules': str(workspace / 'node_modules'), 'native': artifacts}

    def environment(self, env):
        return dict(env, SCG_EXEC_TRACE_FD=str(self.write_fd), SCG_EXEC_POLICY=json.dumps(self.policy, separators=(',', ':')))

    def command(self, argv):
        if argv[0] != self.policy['node']:
            raise ValueError('instrumented root must be the pinned Node')
        return [argv[0], '--import', self.policy['preloader'], *argv[1:]]

    def parent_close(self):
        if self.write_fd is not None:
            os.close(self.write_fd)
            self.write_fd = None

    def drain(self):
        while True:
            try:
                data = os.read(self.read_fd, 65536)
            except BlockingIOError:
                break
            if not data:
                break
            self.total += len(data)
            if self.total > 2097152:
                raise ValueError('execution trace exceeded bounded receipt')
            self.buffer += data
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                row = json.loads(line)
                if not isinstance(row, dict) or type(row.get('pid')) is not int:
                    raise ValueError('invalid execution trace record')
                self.records.append(row)
                if row.get('kind') == 'refused':
                    raise ValueError('execution preloader refused an operation')

    def finish(self):
        self.parent_close()
        self.drain()
        hellos = {row['pid'] for row in self.records if row.get('kind') == 'hello' and row.get('executable') == self.policy['node'] and row.get('preloaderSha256') == self.policy['preloaderSha256']}
        expected = {self.root_pid, *self.node_pids}
        expected.update(row['childPid'] for row in self.records if row.get('kind') == 'spawn' and type(row.get('childPid')) is int and row.get('expectsNode'))
        expected.discard(None)
        result = {'ok': not self.buffer and bool(expected) and expected.issubset(hellos) and not any(row.get('kind') == 'refused' for row in self.records), 'preloaderSha256': self.policy['preloaderSha256'], 'expectedNodePids': sorted(expected), 'helloPids': sorted(hellos), 'missingHelloPids': sorted(expected - hellos), 'records': self.records, 'addedFlag': ['--import', self.policy['preloader']], 'nativeArtifacts': self.policy['native'], 'transport': 'inherited fd; preloader opens no files or trace files'}
        os.close(self.read_fd)
        return result
