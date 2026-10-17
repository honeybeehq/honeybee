import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

from focused_mediation import Mediation
from focused_profile import TEMPLATE
from focused_trace import Trace


class IpcTests(unittest.TestCase):
    def test_inherited_request_fds_reach_node_descendant_and_serialize_response(self):
        node = os.environ.get('SCG_NODE_BIN') or shutil.which('node')
        self.assertIsNotNone(node)
        node = str(Path(node).resolve())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            workspace = root / 'src'
            gate = workspace / 'scripts/gates/darwin'
            gate.mkdir(parents=True)
            shutil.copyfile(Path(__file__).with_name('focused-preload.mjs'), gate / 'focused-preload.mjs')
            contents = {'parent.mjs': "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['host.mjs'],{stdio:'inherit'}); child.on('exit',code=>{process.exitCode=code;});", 'host.mjs': "try {process.kill(" + str(os.getpid()) + ",0);} catch {console.log('controller-refused');}"}
            files = []
            entries = []
            for name, content in contents.items():
                path = workspace / name
                path.write_text(content)
                files.append({'path': name, 'siblingClosure': True})
                entries.append({'role': 'test-runner' if name == 'parent.mjs' else 'runner-host-main', 'path': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
            mediation = Mediation(root, workspace, node, root, 'row', TEMPLATE, gate / 'renderer', {}, [])
            trace = Trace(root, workspace, node, {'files': files, 'nodeEntries': entries}, {}, mediation=mediation)
            env = trace.environment({'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'HOME': str(root), 'TMPDIR': str(root)})
            passed = (trace.write_fd, mediation.request_fd, mediation.response_fd, mediation.lock_read_fd, mediation.lock_write_fd)
            process = subprocess.Popen(trace.command([node, 'parent.mjs']), cwd=workspace, env=env, pass_fds=passed, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            trace.root_pid = process.pid
            trace.parent_close()
            mediation.parent_close()
            failures = []
            def serve():
                try:
                    deadline = time.monotonic() + 5
                    while process.poll() is None and time.monotonic() < deadline:
                        try:
                            data = os.read(mediation.read_fd, 4096)
                        except BlockingIOError:
                            time.sleep(0.001)
                            continue
                        if not data:
                            time.sleep(0.001)
                            continue
                        request = json.loads(data)
                        self.assertEqual(request['operation'], 'signal')
                        self.assertEqual(request['target'], os.getpid())
                        response = {'pid': request['pid'], 'id': request['id'], 'allowed': False}
                        os.write(mediation.write_fd, (json.dumps(response) + '\n').encode())
                except BaseException as error:
                    failures.append(error)
            server = threading.Thread(target=serve)
            server.start()
            stdout, stderr = process.communicate(timeout=6)
            server.join(timeout=1)
            try:
                result = trace.finish()
            except ValueError:
                result = {'ok': False, 'records': trace.records}
            mediation.close()
            self.assertFalse(server.is_alive())
            self.assertEqual(failures, [])
            self.assertEqual(process.returncode, 0, stderr)
            self.assertIn('controller-refused', stdout)
            self.assertFalse(result['ok'])
            self.assertTrue(any(row.get('operation') == 'controller mediation refused' for row in result['records']))


if __name__ == '__main__':
    unittest.main()
