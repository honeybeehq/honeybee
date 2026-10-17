import json
import base64
import os
from pathlib import Path

import focused_native


class Trace:
    def __init__(self, root, workspace, node, audit, native, mediation=None):
        self.mediation = mediation
        self.records = []
        self.buffer = b''
        self.frames = {}
        self.total = 0
        self.root_pid = None
        self.node_pids = set()
        self.node_observations = []
        preloader = focused_native.confined(workspace / 'scripts/gates/darwin/focused-preload.mjs', root)
        artifacts = {}
        for kind, state in native.items():
            path = workspace / 'dist/v2' / kind / 'darwin-arm64' / (kind + '.node')
            info = state['files'][str(path.relative_to(root))]
            artifacts[str(path)] = {'sha256': info['sha256'], 'inode': str(info['ino']), 'mtimeNs': str(info['mtimeNs'])}
        entries = {}
        for row in audit['nodeEntries']:
            path = focused_native.confined(workspace / row['path'], root)
            if focused_native.digest(path) != row['sha256']:
                raise ValueError('Node entry differs from reviewed SHA pin')
            entries[str(path)] = {'role': row['role'], 'sha256': row['sha256']}
        self.policy = {'root': str(workspace.parent), 'node': node, 'entries': entries, 'rowId': mediation.row_id if mediation else None, 'mediationRequired': mediation is not None, 'preloader': str(preloader), 'preloaderSha256': focused_native.digest(preloader), 'files': [str(workspace / row['path']) for row in audit['files'] if row['siblingClosure']], 'forbiddenEntries': [str(workspace / 'scripts' / ('build-' + kind + '.mjs')) for kind in ('delivery-file', 'peercred')], 'modules': str(workspace / 'node_modules'), 'native': artifacts}
        self.read_fd, self.write_fd = os.pipe()
        os.set_blocking(self.read_fd, False)

    def environment(self, env):
        env = self.mediation.environment(env) if self.mediation else env
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
                frame = json.loads(line)
                if not isinstance(frame, dict) or set(frame) != {'pid', 'seq', 'part', 'parts', 'data'} or not all(type(frame[key]) is int for key in ('pid', 'seq', 'part', 'parts')) or not (frame['pid'] > 0 and frame['seq'] > 0 and 0 <= frame['part'] < frame['parts'] <= 32):
                    raise ValueError('invalid execution trace frame')
                key = (frame['pid'], frame['seq'])
                pending = self.frames.setdefault(key, {'parts': frame['parts'], 'chunks': {}})
                if pending['parts'] != frame['parts'] or frame['part'] in pending['chunks']:
                    raise ValueError('duplicate or inconsistent trace frame')
                chunk = base64.b64decode(frame['data'], validate=True)
                if len(chunk) > 192:
                    raise ValueError('trace frame exceeds atomic bound')
                pending['chunks'][frame['part']] = chunk
                if len(pending['chunks']) != pending['parts']:
                    continue
                row = json.loads(b''.join(pending['chunks'][index] for index in range(pending['parts'])))
                del self.frames[key]
                if not isinstance(row, dict) or type(row.get('pid')) is not int:
                    raise ValueError('invalid execution trace record')
                if row['pid'] != frame['pid']:
                    raise ValueError('trace frame pid differs from record')
                if row.get('kind') not in ('hello', 'spawn', 'dlopen', 'argv-instrumented', 'refused'):
                    raise ValueError('unknown execution trace record')
                self.records.append(row)
                if row.get('kind') == 'refused':
                    raise ValueError('execution preloader refused an operation')

    def finish(self):
        self.parent_close()
        try:
            self.drain()
        except (ValueError, OSError, TypeError, KeyError):
            os.close(self.read_fd)
            raise
        hellos = {row['pid'] for row in self.records if row.get('kind') == 'hello' and row.get('executable') == self.policy['node'] and row.get('preloaderSha256') == self.policy['preloaderSha256']}
        expected = {self.root_pid, *self.node_pids}
        expected.update(row['childPid'] for row in self.records if row.get('kind') == 'spawn' and type(row.get('childPid')) is int and row.get('expectsNode'))
        expected.discard(None)
        launch_ids = {row.get('launchId') for row in self.records if row.get('kind') == 'argv-instrumented'}
        hello_ids = {row.get('launchId') for row in self.records if row.get('kind') == 'hello' and row['pid'] in hellos}
        missing_launches = launch_ids - hello_ids
        allowed = {self.policy['node'], '/usr/bin/sandbox-exec'}
        forbidden = [row for row in self.records if row.get('kind') in ('spawn', 'argv-instrumented') and row.get('executable') not in allowed]
        invalid_native = [row for row in self.records if row.get('kind') == 'dlopen' and (row.get('artifact') not in self.policy['native'] or row.get('controllerSha256') != self.policy['native'][row['artifact']]['sha256'])]
        uncovered = []
        for sample in self.node_observations:
            birth = sample['birth']
            earliest = int(birth[2]) * 1000 + int(birth[3]) // 1000
            if not any(row.get('kind') == 'hello' and row['pid'] == int(birth[0]) and type(row.get('emittedAtMs')) is int and row['emittedAtMs'] >= earliest for row in self.records):
                uncovered.append(sample)
        result = {'ok': not self.buffer and not self.frames and bool(expected) and expected.issubset(hellos) and not missing_launches and not forbidden and not invalid_native and not uncovered and not any(row.get('kind') == 'refused' for row in self.records), 'preloaderSha256': self.policy['preloaderSha256'], 'sampledNodeExecutionCount': len(self.node_observations), 'uncoveredNodeExecutions': uncovered, 'expectedNodePids': sorted(expected), 'helloPids': sorted(hellos), 'missingHelloPids': sorted(expected - hellos), 'missingLaunchHellos': sorted(str(value) for value in missing_launches), 'records': self.records, 'addedFlag': ['--import', self.policy['preloader']], 'nativeArtifacts': self.policy['native'], 'transport': 'inherited fd; atomic frames at most 512 bytes; preloader opens no files or trace files'}
        os.close(self.read_fd)
        return result
