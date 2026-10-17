import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import focused_trace


class TraceTests(unittest.TestCase):
    def launch(self, files, entry='parent.mjs', flags=(), roles=None, extra_env=None):
        node = os.environ.get('SCG_NODE_BIN') or shutil.which('node')
        self.assertIsNotNone(node, 'pinned Node required for trace tests')
        node = str(Path(node).resolve())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            workspace = root / 'src'
            gate = workspace / 'scripts/gates/darwin'
            gate.mkdir(parents=True)
            shutil.copyfile(Path(__file__).with_name('focused-preload.mjs'), gate / 'focused-preload.mjs')
            for name, content in files.items():
                (workspace / name).parent.mkdir(parents=True, exist_ok=True)
                (workspace / name).write_text(content)
            audit = {'files': [{'path': name, 'siblingClosure': True} for name in files if name != 'unpinned.mjs']}
            audit['nodeEntries'] = [{'role': (roles or {}).get(name, 'test-runner' if name == entry else 'runner-host-main'), 'path': name, 'sha256': hashlib.sha256((workspace / name).read_bytes()).hexdigest()} for name in files if name != 'unpinned.mjs']
            trace = focused_trace.Trace(root, workspace, node, audit, {})
            env = trace.environment({'HOME': str(root), 'TMPDIR': str(root), 'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'LANG': 'C'})
            env.update(extra_env or {})
            process = subprocess.Popen(trace.command([node, *flags, entry]), cwd=workspace, env=env, pass_fds=(trace.write_fd,), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            trace.root_pid = process.pid
            trace.parent_close()
            stdout, stderr = process.communicate(timeout=10)
            try:
                result = trace.finish()
            except ValueError as error:
                result = {'ok': False, 'error': str(error), 'records': trace.records}
            return process.returncode, stdout, stderr, result

    def test_pinned_node_descendant_has_hello_and_added_flag(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "import {spawnSync} from 'node:child_process'; const child=spawnSync(process.execPath,['child.mjs'],{encoding:'utf8'}); process.stdout.write(child.stdout); if(child.status!==0) throw new Error(child.stderr);", 'child.mjs': "console.log('child-ok');"})
        self.assertEqual(code, 0, stderr)
        self.assertIn('child-ok', stdout)
        self.assertTrue(trace['ok'], trace)
        self.assertEqual(len(trace['helloPids']), 2)
        self.assertTrue(any(row['kind'] == 'argv-instrumented' for row in trace['records']))

    def test_sealed_typescript_host_entry_runs_with_pinned_node(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "import {spawnSync} from 'node:child_process'; const child=spawnSync(process.execPath,['--experimental-strip-types','host.ts'],{encoding:'utf8'}); process.stdout.write(child.stdout); if(child.status!==0) throw new Error(child.stderr);", 'host.ts': "import {basename} from 'node:path'; export const label: string=basename('/fixture/ts-ok'); console.log(label);"})
        self.assertEqual(code, 0, stderr)
        self.assertIn('ts-ok', stdout)
        self.assertTrue(trace['ok'], trace)

    def test_node_test_runner_children_emit_hello(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "import {test} from 'node:test'; test('fixture', () => {});"}, flags=('--test', '--test-isolation=none', '--test-concurrency=1', '--test-reporter=tap'))
        self.assertEqual(code, 0, stdout + stderr + repr(trace))
        self.assertIn('ok 1', stdout)
        self.assertTrue(trace['ok'], trace)
        self.assertGreaterEqual(len(trace['helloPids']), 1)

    def test_default_isolation_instrumentation_fails_closed(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "import {test} from 'node:test'; test('fixture', () => {});"}, flags=('--test', '--test-concurrency=1', '--test-reporter=tap'))
        self.assertNotEqual(code, 0)
        self.assertFalse(trace['ok'])
        self.assertTrue(trace['missingHelloPids'])
        self.assertIn('invalid argument, write', stdout + stderr)

    def test_sync_execfile_launch_requires_its_own_hello(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "import {execFileSync} from 'node:child_process'; process.stdout.write(execFileSync(process.execPath,['child.mjs'],{encoding:'utf8'}));", 'child.mjs': "console.log('sync-child-ok');"})
        self.assertEqual(code, 0, stderr)
        self.assertTrue(trace['ok'], trace)
        self.assertEqual(trace['missingLaunchHellos'], [])
        self.assertEqual(len(trace['helloPids']), 2)

    def test_async_and_fork_descendants_preserve_trace_fd(self):
        for parent in ("import {spawn} from 'node:child_process'; const c=spawn(process.execPath,['child.mjs'],{stdio:'inherit'}); c.on('exit',code=>{process.exitCode=code;});", "import {fork} from 'node:child_process'; const c=fork('child.mjs'); c.on('exit',code=>{process.exitCode=code;});"):
            code, stdout, stderr, trace = self.launch({'parent.mjs': parent, 'child.mjs': "console.log('async-child-ok');"})
            self.assertEqual(code, 0, stderr)
            self.assertIn('async-child-ok', stdout)
            self.assertTrue(trace['ok'], trace)
            self.assertEqual(len(trace['helloPids']), 2)

    def test_promisified_execfile_preserves_result_and_child(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "import {execFile} from 'node:child_process'; import {promisify} from 'node:util'; const p=promisify(execFile)(process.execPath,['child.mjs']); if(!p.child?.pid) throw new Error('missing child'); const result=await p; if(result.stderr!=='') throw new Error('stderr changed'); process.stdout.write(result.stdout);", 'child.mjs': "console.log('promisified-child-ok');"})
        self.assertEqual(code, 0, stderr + repr(trace))
        self.assertIn('promisified-child-ok', stdout)
        self.assertTrue(trace['ok'], trace)

    def test_unreviewed_native_module_is_refused_before_dlopen(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "try {process.dlopen({exports:{}}, './evil.node');} catch {}", 'evil.node': 'not a native artifact'})
        self.assertEqual(code, 0, stderr)
        self.assertFalse(trace['ok'])
        self.assertTrue(any(row['kind'] == 'refused' and row['operation'] == 'unapproved native module' for row in trace['records']))

    def test_build_script_entry_refuses_even_when_source_is_audited(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "import {spawnSync} from 'node:child_process'; try {spawnSync(process.execPath,['scripts/build-delivery-file.mjs']);} catch {}", 'scripts/build-delivery-file.mjs': "console.log('must-not-build');"})
        self.assertEqual(code, 0, stderr)
        self.assertNotIn('must-not-build', stdout)
        self.assertFalse(trace['ok'])
        self.assertTrue(any(row['kind'] == 'refused' and row['operation'] == 'build entry forbidden in test process' for row in trace['records']))

    def test_ps_is_refused_even_when_caller_catches(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "import {execFileSync} from 'node:child_process'; try {execFileSync('ps',[]);} catch {}"})
        self.assertEqual(code, 0, stderr)
        self.assertFalse(trace['ok'])
        self.assertTrue(any(row['kind'] == 'refused' and row['executable'] == 'ps' for row in trace['records']))

    def test_module_register_is_refused_even_when_caller_catches(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "import {register} from 'node:module'; try {register('data:text/javascript,export{}');} catch {}"})
        self.assertEqual(code, 0, stderr)
        self.assertFalse(trace['ok'])
        self.assertTrue(any(row['kind'] == 'refused' and row['operation'] == 'module hook replacement' for row in trace['records']))

    def test_network_hook_preserves_root_local_unix_socket_behavior(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "import net from 'node:net'; import {resolve} from 'node:path'; const path=resolve('fixture.sock'); const server=net.createServer(socket=>socket.end('unix-ok')); server.listen(path,()=>{const client=net.connect(path); client.setEncoding('utf8'); client.on('data',data=>process.stdout.write(data)); client.on('end',()=>server.close());});"})
        self.assertEqual(code, 0, stderr)
        self.assertIn('unix-ok', stdout)
        self.assertTrue(trace['ok'], trace)

    def test_network_hooks_refuse_even_if_the_candidate_catches(self):
        for code in ("import net from 'node:net'; try {net.connect(443, '192.0.2.1');} catch {}", "import dns from 'node:dns'; try {dns.lookup('fixture.invalid',()=>{});} catch {}", "try {fetch('https://fixture.invalid');} catch {}", "try {new WebSocket('wss://fixture.invalid');} catch {}", "import dgram from 'node:dgram'; try {dgram.createSocket('udp4');} catch {}", "import net from 'node:net'; import {symlinkSync} from 'node:fs'; symlinkSync('/forbidden-host.sock', './redirect.sock'); try {net.connect('./redirect.sock');} catch {}"):
            with self.subTest(code=code):
                status, stdout, stderr, trace = self.launch({'parent.mjs': code})
                self.assertEqual(status, 0, stderr)
                self.assertFalse(trace['ok'])
                self.assertTrue(any(row['kind'] == 'refused' for row in trace['records']))

    def test_runner_host_wrong_parent_roles_are_refused(self):
        cases = (
            ({'parent.mjs': "console.log('must-not-run');"}, {'parent.mjs': 'runner-host-main'}, {}),
            ({'parent.mjs': "import {spawnSync} from 'node:child_process'; try {spawnSync(process.execPath,['host.mjs']);} catch {}", 'host.mjs': "console.log('must-not-run');"}, {'parent.mjs': 'reader', 'host.mjs': 'runner-host-main'}, {'SCG_EXEC_PARENT_ROLE': 'runner-host-main', 'SCG_EXEC_RECIPIENT': '1'}),
            ({'parent.mjs': "import {spawnSync} from 'node:child_process'; try {spawnSync('/usr/bin/sandbox-exec',['-f','fixture.sb',process.execPath,'host.mjs']);} catch {}", 'host.mjs': "console.log('must-not-run');"}, {'parent.mjs': 'test-runner', 'host.mjs': 'runner-host-main'}, {}),
        )
        for files, roles, extra in cases:
            with self.subTest(roles=roles, extra=extra):
                code, stdout, stderr, trace = self.launch(files, roles=roles, extra_env=extra)
                self.assertNotIn('must-not-run', stdout)
                self.assertFalse(trace['ok'])
                self.assertTrue(any(row['kind'] == 'refused' and row['operation'] == 'Node entry parent role mismatch' for row in trace['records']))

    def test_unpinned_import_is_refused(self):
        code, stdout, stderr, trace = self.launch({'parent.mjs': "await import('./unpinned.mjs');", 'unpinned.mjs': "throw new Error('must not execute');"})
        self.assertNotEqual(code, 0)
        self.assertFalse(trace['ok'])
        self.assertNotIn('must not execute', stderr)

    def test_missing_node_hello_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            preloader = root / 'scripts/gates/darwin/focused-preload.mjs'
            preloader.parent.mkdir(parents=True)
            preloader.write_text('')
            trace = focused_trace.Trace(root, root, '/pinned/node', {'files': [], 'nodeEntries': []}, {})
            trace.root_pid = 100
            result = trace.finish()
            self.assertFalse(result['ok'])
            self.assertEqual(result['missingHelloPids'], [100])


if __name__ == '__main__':
    unittest.main()
