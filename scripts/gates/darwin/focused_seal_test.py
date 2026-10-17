from pathlib import Path
import os
import tempfile
import unittest

from focused_seal import copy_dependencies, copy_file, digest, prepare, root_users


class SealTests(unittest.TestCase):
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
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as temporary:
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
                if mismatch:
                    (root / 'scope').write_text('outer changed scanner')
                    with self.assertRaisesRegex(ValueError, 'reviewed pin'):
                        prepare(root, workspace, str(node), {'files': []}, controls, native, {})
                else:
                    sealed, copied, copied_node = prepare(root, workspace, str(node), {'files': []}, controls, native, {})
                    self.assertEqual(digest(sealed / 'control/scope'), controls[str(root / 'scope')][-1])
                    self.assertNotEqual((sealed / 'control/scope').stat().st_ino, (root / 'scope').stat().st_ino)
                    self.assertEqual(digest(Path(copied_node)), controls[str(node)][-1])

    def test_same_uid_open_file_cwd_and_image_are_all_root_uses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            output = 'p10\nn' + str(root / 'controller') + '\np11\nn' + str(root / 'cwd') + '\nn' + str(root / 'node') + '\nn' + str(root / 'open') + '\np12\nn/elsewhere\n'
            rows = root_users(root, output, 10)
            self.assertEqual([row['pid'] for row in rows], [11, 11, 11])
            with self.assertRaisesRegex(ValueError, 'absent'):
                root_users(root, '', os.getpid())


if __name__ == '__main__':
    unittest.main()
