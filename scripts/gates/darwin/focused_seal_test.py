from pathlib import Path
from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
import stat
import tempfile
import unittest
from unittest.mock import patch

import focused_seal
from focused_seal import copy_dependencies, copy_file, digest, prepare, root_users


class SealTests(unittest.TestCase):
    def test_existing_control_directory_wrong_mode_or_owner_is_refused(self):
        for case in ('mode', 'owner'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                sealed = Path(temporary).resolve()
                control = sealed / 'control'
                control.mkdir(mode=0o700)
                if case == 'mode':
                    control.chmod(0o755)
                    with self.assertRaisesRegex(ValueError, 'owner or mode'):
                        focused_seal.private_control_directory(sealed)
                else:
                    with patch('focused_seal.os.getuid', return_value=os.getuid() + 1), self.assertRaisesRegex(ValueError, 'owner or mode'):
                        focused_seal.private_control_directory(sealed)

    def test_copy_has_new_inode_and_rejects_redirected_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / 'source'
            source.write_bytes(b'pinned bytes')
            copied = root / 'copy'
            copy_file(source, copied)
            self.assertNotEqual(source.stat().st_ino, copied.stat().st_ino)
            self.assertEqual(copied.stat().st_nlink, 1)
            fifo = root / 'fifo'
            os.mkfifo(fifo)
            with self.assertRaisesRegex(ValueError, 'non-regular'):
                copy_file(fifo, root / 'fifo-copy')
            source.write_bytes(b'outer mutated')
            self.assertEqual(copied.read_bytes(), b'pinned bytes')
            (root / 'link').symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'redirected'):
                copy_file(root / 'link', root / 'redirected')
            with self.assertRaisesRegex(ValueError, 'reviewed pin'):
                copy_file(source, root / 'wrong', '0' * 64)

    def test_dependency_links_stay_inside_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / 'modules'
            source.mkdir()
            (source / 'entry').write_text('pinned')
            (source / 'alias').symlink_to('entry')
            copy_dependencies(source, root / 'copied')
            self.assertEqual((root / 'copied/alias').resolve(), root / 'copied/entry')
            expected = {'entry': {'sha256': digest(source / 'entry')}, 'alias': {'link': 'entry'}}
            (source / 'entry').write_text('outer changed dependency')
            with self.assertRaisesRegex(ValueError, 'reviewed pin'):
                copy_dependencies(source, root / 'wrong-pinned-copy', expected)
            (source / 'entry').write_text('pinned')
            (source / 'escape').symlink_to('../outside')
            (root / 'outside').write_text('forbidden')
            with self.assertRaisesRegex(ValueError, 'escapes'):
                copy_dependencies(source, root / 'refused')

    def test_sealed_controls_and_node_use_pre_outer_memory_pins(self):
        for mismatch in (False, True):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory(prefix='g.') as temporary:
                root = Path(temporary).resolve()
                workspace = root / 'src'
                gate = workspace / 'scripts/gates/darwin'
                gate.mkdir(parents=True)
                (workspace / 'node_modules').mkdir()
                controls = {}
                paths = [root / name for name in ('scope', 'workload.sb', 'compiler.sb')] + [gate / name for name in ('focused-preload.mjs', 'focused-manifest.json', 'focused-render-profile.mjs', 'start_wait.py')]
                node = root / 'original-node'
                paths.append(node)
                for path in paths:
                    path.write_text('pinned ' + path.name)
                    controls[str(path)] = (digest(path),)
                native = {}
                for kind in ('delivery-file', 'peercred'):
                    records = {}
                    for relative in ('v2/daemon/native/' + kind + '.c', 'dist/v2/' + kind + '/darwin-arm64/' + kind + '.node', 'dist/v2/' + kind + '/darwin-arm64/manifest.json'):
                        path = workspace / relative
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text('controller built fixture')
                        records[str(path.relative_to(root))] = {'sha256': digest(path)}
                    native[kind] = {'files': records}
                (workspace / 'package.json').write_text('{}')
                (root / 't').mkdir()
                focused_seal.ROOT_CREATION[str(root)] = {'beforeMkdirNs': 200000000000}
                focused_seal.quiescence_input(root, root / 'scope')
                probe_ino = (root / 'sealed-target/quiescence-probe').stat().st_ino
                if mismatch:
                    (root / 'scope').write_text('outer changed scanner')
                    with self.assertRaisesRegex(ValueError, 'reviewed pin'):
                        prepare(root, workspace, str(node), {'files': []}, controls, native, {})
                else:
                    previous_umask = os.umask(0o022)
                    try:
                        sealed, copied, copied_node = prepare(root, workspace, str(node), {'files': []}, controls, native, {})
                    finally:
                        os.umask(previous_umask)
                    from focused_barrier import Barrier
                    barrier = Barrier(sealed / 'control', 'b-p0.sock', None)
                    barrier.close()
                    self.assertEqual(stat.S_IMODE((sealed / 'control').stat().st_mode), 0o700)
                    self.assertEqual((sealed / 'control').stat().st_uid, os.getuid())
                    self.assertEqual((sealed / 'quiescence-probe').stat().st_ino, probe_ino)
                    self.assertFalse((copied / 'quiescence-probe').exists())
                    self.assertEqual(digest(sealed / 'control/scope'), controls[str(root / 'scope')][-1])
                    self.assertNotEqual((sealed / 'control/scope').stat().st_ino, (root / 'scope').stat().st_ino)
                    self.assertEqual(digest(Path(copied_node)), controls[str(node)][-1])

    def test_precreated_probe_extra_entry_and_swapped_directory_refuse(self):
        for mutation in ('extra', 'swapped'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                (root / 'src').mkdir()
                (root / 'src/package.json').write_text('{}')
                (root / 't').mkdir()
                focused_seal.ROOT_CREATION[str(root)] = {'beforeMkdirNs': 200000000000}
                focused_seal.quiescence_input(root, root / 'scope')
                sealed = root / 'sealed-target'
                probe = sealed / 'quiescence-probe'
                self.assertIn((probe.stat().st_dev, probe.stat().st_ino), focused_seal.ROOT_INODES[str(root)])
                if mutation == 'extra':
                    (sealed / 'extra').write_text('unexpected')
                else:
                    sealed.rename(root / 'original-sealed')
                    sealed.mkdir(mode=0o700)
                    (sealed / 'quiescence-probe').write_text('replacement')
                with self.assertRaisesRegex(ValueError, 'sealed probe'):
                    prepare(root, root / 'src', '/node', {}, {}, {}, {})

    def test_own_root_uses_keep_birth_and_relative_path_foreign_uses_keep_only_counts(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(focused_seal, 'GATE_LAUNCH_BIRTHS', {('11','10','100','1')}):
            root = Path(temporary).resolve()
            output = 'OWN\t11\t10\t100\t1\tcwd\tsrc\nFOREIGN\tfd\t2\nCOMPLETE\n'
            rows = root_users(root, output, 10)
            self.assertEqual(rows, [{'pid': 11, 'birth': ['11','10','100','1'], 'category': 'cwd', 'path': 'src'}])
            self.assertEqual(focused_seal.FOREIGN_ROOT_USE_COUNTS, {'cwd':0,'exe':0,'fd':2})
            error = focused_seal.BusyRoot(rows, focused_seal.FOREIGN_ROOT_USE_COUNTS)
            self.assertNotIn('11', str(error))
            self.assertNotIn(str(root), str(error))
            for bad in ('', 'OWN\t12\t10\t100\t1\tcwd\tsrc\nCOMPLETE\n', 'FOREIGN\tfd\t2\t/private/foreign\nCOMPLETE\n', 'OWN\t11\t10\t100\t1\tcwd\t/absolute\nCOMPLETE\n'):
                with self.assertRaises(ValueError):
                    root_users(root, bad, 10)

    def test_leftovers_require_a_retained_birth_and_never_store_none(self):
        import guard
        with patch.object(focused_seal, 'GATE_LAUNCH_BIRTHS', {('11','10','100','1')}), patch.object(focused_seal, 'UNOBSERVED_OWN_CHILDREN', []), tempfile.TemporaryDirectory() as temporary:
            rows = []
            output, errors = io.StringIO(), io.StringIO()
            with redirect_stdout(output), redirect_stderr(errors):
                focused_seal.record_leftover(rows, {'pid':11,'birth':['11','10','100','1']})
                candidate = {'pid':987654321,'birth':None,'argv':['/unverified-argv-marker'],'path':'/unverified-path-marker','fixture':'/unverified-fixture-marker','reason':'/unverified-reason-marker'}
                focused_seal.record_leftover(rows, candidate, unverified_label='focused-step')
                focused_seal.record_leftover(rows, candidate, unverified_label='focused-step')
                focused_seal.record_leftover(rows, candidate, unverified_label='/unverified-label-marker')
                with self.assertRaises(ValueError) as caught:
                    focused_seal.record_leftover(rows, {'pid':987654321,'birth':['987654321','10','100','1'],'argv':candidate['argv']})
                root=Path(temporary).resolve()
                with patch.object(guard, 'LEFTOVER_CHILDREN', rows):
                    guard.write_json(root/'receipt.json', {'exit':90,'reason':str(caught.exception)}, root)
            self.assertEqual(len(rows),1)
            self.assertTrue(all(row['birth'] is not None for row in rows))
            expected=[{'fixture':'focused-step','count':2},{'fixture':'unverified-child','count':1}]
            self.assertEqual(focused_seal.UNOBSERVED_OWN_CHILDREN, expected)
            receipt=json.loads((root/'receipt.json').read_text())
            self.assertEqual(receipt['unobservedOwnChildren'],expected)
            for row in receipt['unobservedOwnChildren']:
                self.assertEqual(set(row),{'fixture','count'})
            combined=output.getvalue()+errors.getvalue()+json.dumps(receipt)+str(caught.exception)+str(focused_seal.BusyRoot([],{'cwd':1,'exe':0,'fd':0}))
            for secret in ('987654321','/unverified-argv-marker','/unverified-path-marker','/unverified-fixture-marker','/unverified-reason-marker','/unverified-label-marker'):
                self.assertNotIn(secret,combined)
            self.assertEqual(output.getvalue()+errors.getvalue(),'')


if __name__ == '__main__':
    unittest.main()
