from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform.startswith('linux'), 'parser C regression compiles on Linux only')
class ArgvTests(unittest.TestCase):
    def test_argc_boundary_environment_not_surfaced_and_truncation_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / 'parser.c'
            source.write_text('#include <stdio.h>\n#include "argv_observation.h"\nint main(int argc, char **argv) { unsigned char data[8192]; struct argv_span args[16]; size_t count=0; size_t size=fread(data,1,sizeof(data),stdin); if(!parse_argv_only(data,size,args,16,&count)) return 95; if(argc==2) return reader_argv_exact(data,args,count,"/node","/reader",argv[1]) ? 0 : 95; for(size_t i=0;i<count;i++) printf("%.*s\\n",(int)args[i].size,data+args[i].start); return 0; }\n')
            binary = root / 'parser'
            subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(Path(__file__).parent), str(source), '-o', str(binary)], check=True, capture_output=True, timeout=10)
            argv = [b'sandbox-exec', b'-f', b'/fixture/profile', b'/fixture/node', b'/fixture/reader']
            prefix = struct.pack('i', len(argv)) + b'/usr/bin/sandbox-exec\0\0'
            payload = prefix + b'\0'.join(argv) + b'\0'
            result = subprocess.run([str(binary)], input=payload + b'PRIVATE_ENV=must-never-surface\0OTHER=private\0', capture_output=True, timeout=2)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), argv)
            self.assertNotIn(b'PRIVATE', result.stdout)
            for mode, arguments, expected in (
                ('-', [b'/node', b'/reader'], 0),
                ('-', [b'/node', b'--no-warnings', b'/reader'], 95),
                ('-', [b'/node', b'/reader', b'extra'], 95),
                ('/pinned/preload', [b'/node', b'--import', b'/pinned/preload', b'/reader'], 0),
                ('/pinned/preload', [b'/node', b'--import', b'/wrong', b'/reader'], 95),
                ('/pinned/preload', [b'/node', b'/reader'], 95)):
                data = struct.pack('i', len(arguments)) + b'/node\0\0' + b'\0'.join(arguments) + b'\0'
                result = subprocess.run([str(binary), mode], input=data, capture_output=True, timeout=2)
                self.assertEqual(result.returncode, expected)
            for truncated in (payload[:-1], payload[:2], struct.pack('i', 17) + payload[4:]):
                result = subprocess.run([str(binary)], input=truncated, capture_output=True, timeout=2)
                self.assertEqual(result.returncode, 95)
                self.assertEqual(result.stdout, b'')


if __name__ == '__main__':
    unittest.main()
