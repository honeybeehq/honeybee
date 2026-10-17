import json
from pathlib import Path
import tempfile
import unittest

from focused_native import artifact_state, digest, build


class NativeTests(unittest.TestCase):
    def test_native_source_must_match_archive_before_any_compiler_or_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            workspace = root / 'src'
            source = workspace / 'v2/daemon/native/peercred.c'
            source.parent.mkdir(parents=True)
            source.write_text('changed after archive')
            with self.assertRaisesRegex(ValueError, 'pinned candidate archive'):
                build(root, workspace, {}, '/absent/node', {}, 'peercred', source_sha256='0' * 64)
            self.assertFalse((workspace / 'dist').exists())
    def test_peercred_manifest_matches_loader_and_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            workspace = root / 'src'
            source = workspace / 'v2/daemon/native/peercred.c'
            source.parent.mkdir(parents=True)
            source.write_text('peercred source')
            directory = workspace / 'dist/v2/peercred/darwin-arm64'
            directory.mkdir(parents=True)
            binary = directory / 'peercred.node'
            binary.write_bytes(b'peercred artifact')
            data = {'version': 1, 'target': 'darwin-arm64', 'napi': 8, 'sourceSha256': digest(source), 'sha256': digest(binary)}
            (directory / 'manifest.json').write_text(json.dumps(data))
            self.assertEqual(artifact_state(workspace, root, 'peercred')['manifest'], data)
            data['target'] = 'linux-x64'
            (directory / 'manifest.json').write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                artifact_state(workspace, root, 'peercred')

    def test_manifest_schema_and_rebuild_detection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            workspace = root / 'src'
            source = workspace / 'v2/daemon/native/delivery-file.c'
            source.parent.mkdir(parents=True)
            source.write_text('pinned source')
            directory = workspace / 'dist/v2/delivery-file/darwin-arm64'
            directory.mkdir(parents=True)
            binary = directory / 'delivery-file.node'
            binary.write_bytes(b'compiled helper')
            manifest = directory / 'manifest.json'
            data = {'version': 1, 'target': 'darwin-arm64', 'napi': 8, 'sourceSha256': digest(source), 'sha256': digest(binary)}
            manifest.write_text(json.dumps(data))
            before = artifact_state(workspace, root)
            self.assertEqual(before['manifest'], data)
            self.assertEqual(set(before['manifest']), {'version', 'target', 'napi', 'sourceSha256', 'sha256'})
            manifest.write_text(json.dumps(data) + '\n')
            self.assertNotEqual(artifact_state(workspace, root), before)
            binary.write_bytes(b'changed helper')
            with self.assertRaisesRegex(ValueError, 'does not match'):
                artifact_state(workspace, root)


if __name__ == '__main__':
    unittest.main()
