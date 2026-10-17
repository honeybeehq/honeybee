import json
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import unittest
import sys

import node_argv


class NodeFlagTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform.startswith('linux'), 'C flags mock compiles on Linux only')
    def test_real_default_flags_and_role_specific_admissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'flags.c'
            source.write_text('#include <stdio.h>\n#include "argv_observation.h"\n#include "node_flags.h"\nint main(int argc,char **argv) {unsigned char b[65536];struct argv_span a[1024];size_t n=0,e=0;char bad[96]="missing_entry";size_t z=fread(b,1,sizeof(b),stdin);const char *p=argc>1?argv[1]:"-";if(!parse_argv_only(b,z,a,1024,&n))return 95;if(!node_flags_entry(b,a,n,p,&e,bad)||!node_role_argv(b,a,n,e,"/node","/reader",p,"/test.ts","/host.ts",(const char*)b+a[e].start,bad)){fprintf(stderr,"unsupported_flag:%s\\n",bad);return 95;}print_node_flags(stdout,b,a,n,e,p,1);return 0;}\n')
            binary = root / 'flags'
            subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(Path(__file__).parent), str(source), '-o', str(binary)], check=True, capture_output=True, timeout=10)
            def check(args, expected, preloader='-'):
                encoded = [value.encode() for value in ['/node', *args]]
                data = struct.pack('i', len(encoded)) + b'/node\0\0' + b'\0'.join(encoded) + b'\0ENV_SECRET=DO_NOT_SURFACE\0'
                result = subprocess.run([str(binary), preloader], input=data, capture_output=True, timeout=2)
                self.assertEqual(result.returncode, expected, (args, result.stdout, result.stderr))
                self.assertNotIn(b'ENV_SECRET', result.stdout + result.stderr)
                return result
            defaults = json.loads((Path(__file__).parent / 'node24-linux-argv.json').read_text())['flags']
            check([*defaults, '/test.ts'], 0)
            check(['--test', '--test-concurrency=1', '--test-reporter=tap', '/test.ts'], 0)
            for bad in ('--inspect', '--inspect-brk', '--inspect-wait', '--inspect=0.0.0.0:9229', '--inspect-publish-uid=http', '--require=DO_NOT_SURFACE', '--eval=DO_NOT_SURFACE', '--loader=DO_NOT_SURFACE', '--env-file=DO_NOT_SURFACE', '--conditions=DO_NOT_SURFACE', '--test-global-setup=DO_NOT_SURFACE', '--test-reporter=DO_NOT_SURFACE', '--snapshot-blob=DO_NOT_SURFACE', '--allow-fs-write=*', '--unknown=DO_NOT_SURFACE', '--v8-pool-size=1025', '--v8-pool-size=2'):
                result = check([bad, '/test.ts'], 95)
                self.assertNotIn(b'DO_NOT_SURFACE', result.stderr)
            for role, entry in (('test-runner-root', '/test.ts'), ('test-runner-internal', '/test.ts'), ('reader', '/reader'), ('unapproved', '/other.ts')):
                with self.subTest(role=role):
                    check(['--experimental-strip-types', entry], 95)
            check(['--experimental-strip-types', '/host.ts', '/config'], 0)
            check(['--experimental-strip-types', '/other.ts', '/config'], 95)
            check(['--experimental-strip-types', '/host.ts'], 95)
            check(['--import', '/pinned', '--experimental-strip-types', '/host.ts', '/config'], 0, '/pinned')
            check(['--import', '/wrong', '/test.ts'], 95, '/pinned')
            check(['--import', '/pinned', '/test.ts'], 95)
            check(['--import', '/pinned', '--test-isolation=none', '/test.ts'], 0, '/pinned')
            check(['--test-isolation=none', '/test.ts'], 95)
            for name in json.loads((Path(__file__).parent / 'focused-manifest.json').read_text())['files'][1]['sibling']:
                pattern = '^(?:' + re.escape(name) + ')$'
                for value in (pattern, pattern.replace('\\', '\\\\')):
                    check(['--test-name-pattern=' + value, '/test.ts'], 0)

    def test_receipt_capture_schema_and_unknown_values_fail_closed(self):
        flags = json.loads((Path(__file__).parent / 'node24-linux-argv.json').read_text())['flags']
        report = dict(node_argv.validate_flags(flags), platform='darwin', reviewedPatternCaptures=2)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / node_argv.REPORT
            path.write_text(json.dumps(report))
            self.assertEqual(node_argv.receipt_report(root), report)
            for update in ({'reviewedPatternCaptures': 1}, {'extra': 'DO_NOT_SURFACE'}, {'flags': [{'name': '--eval', 'value': 'DO_NOT_SURFACE'}]}):
                path.write_text(json.dumps(dict(report, **update)))
                with self.assertRaises(ValueError) as error:
                    node_argv.receipt_report(root)
                self.assertNotIn('DO_NOT_SURFACE', str(error.exception))

    def test_capture_real_pinned_linux_child(self):
        node = os.environ.get('SCG_NODE_BIN')
        if not node:
            self.skipTest('pinned Node unavailable')
        names = json.loads((Path(__file__).parent / 'focused-manifest.json').read_text())['files'][1]['sibling']
        reports = []
        for name in names:
            with tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'capture.test.mjs'
                path.write_text("import {test} from 'node:test';test(" + json.dumps(name) + ",()=>console.log('SCG_FLAGS='+JSON.stringify({version:process.versions.node,flags:process.execArgv})));\n")
                result = subprocess.run([node, '--test', '--test-concurrency=1', '--test-reporter=tap', '--test-name-pattern=^(?:' + re.escape(name) + ')$', str(path)], env={'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'HOME': temporary, 'TMPDIR': temporary, 'LANG': 'C.UTF-8'}, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, 'Node default-isolation capture failed')
                captured = json.loads(next(line.split('SCG_FLAGS=', 1)[1] for line in result.stdout.splitlines() if 'SCG_FLAGS=' in line))
                self.assertEqual(captured['version'], '24.18.0', 'Node capture version mismatch')
                flags = captured['flags']
                report = dict(node_argv.validate_flags(flags), platform=sys.platform)
                reports.append(report)
        self.assertEqual(len(reports), 2)
        self.assertEqual(reports[0], reports[1], 'reviewed pattern captures differ')
        report = dict(reports[0], reviewedPatternCaptures=2)
        if os.environ.get('SCG_SELF_TEST') == '1' and os.environ.get('GATE_ROOT'):
            destination = Path(os.environ['GATE_ROOT']) / node_argv.REPORT
            if destination.exists() or destination.is_symlink():
                previous = node_argv.receipt_report(destination.parent)
                self.assertEqual(previous['ok'], report['ok'])
                self.assertEqual(sorted(previous['flags'], key=lambda row: (row['name'], row['value'])), sorted(report['flags'], key=lambda row: (row['name'], row['value'])))
            else:
                fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'w') as output:
                    json.dump(report, output, sort_keys=True)
        self.assertTrue(report['ok'], 'unsupported_flag:' + ','.join(report['unsupportedNames']))

@unittest.skipUnless(sys.platform.startswith('linux'), 'scope observation SDK mock compiles on Linux only')
class NodeObservationTests(unittest.TestCase):
    def test_typed_refusals_do_not_surface_values_or_environment(self):
        text = (Path(__file__).parent / 'scope.c').read_text()
        function = text[text.index('static int node_observation('):text.index('\nstatic int write_policy(')]
        stub = r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include "argv_observation.h"
#include "node_flags.h"
#define PROC_PIDPATHINFO_MAXSIZE 512
#define PATH_MAX 4096
#define CTL_KERN 1
#define KERN_PROCARGS2 2
#define PROC_PIDVNODEPATHINFO 3
struct proc_vnodepathinfo { struct { char vip_path[512]; } pvi_cdir; };
static int mode;
static int same_birth(int p,unsigned long long s,unsigned long long u) {(void)p;(void)s;(void)u;return 0;}
static int proc_pidpath(int p,char *b,size_t z) {(void)p;(void)z;strcpy(b,"/node");return 6;}
static int proc_pidinfo(int p,int flavor,int arg,void *b,size_t z) {(void)p;(void)flavor;(void)arg;if(mode==4){errno=EPERM;return 0;}strcpy(((struct proc_vnodepathinfo*)b)->pvi_cdir.vip_path,"/work");return (int)z;}
static char *fake_realpath(const char *p,char *b) {strcpy(b,p);return b;}
#define realpath fake_realpath
static void secure_zero(void *p,size_t z) {memset(p,0,z);}
typedef int (*sandbox_check_function)(int,const char*,int,...);
static int check(int p,const char *op,int f,...) {(void)p;(void)op;(void)f;if(mode==6){errno=EPERM;return -1;}return 0;}
static sandbox_check_function sandbox_checker(void) {return mode==7?NULL:check;}
static int sysctl(int *m,unsigned n,void *out,size_t *size,void *v,size_t vz) {
(void)m;(void)n;(void)v;(void)vz;if(mode==1){errno=EPERM;return -1;}
int argc=mode==2?1025:3;unsigned char *b=out;memcpy(b,&argc,sizeof(argc));size_t p=sizeof(argc);memcpy(b+p,"/node\0\0",7);p+=7;
const char *args[]={"/node",mode==3?"--eval=DO_NOT_SURFACE":"--test",mode==5?"/wrong.ts":"/test.ts"};
for(int i=0;i<3;i++){size_t z=strlen(args[i])+1;memcpy(b+p,args[i],z);p+=z;}
memcpy(b+p,"ENV_SECRET=DO_NOT_SURFACE\0",25);p+=25;*size=p;return 0;}
'''
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'scope-observe.c'
            binary = Path(temporary) / 'observe'
            source.write_text(stub + function + '\nint main(int n,char **a){mode=n>1?atoi(a[1]):0;return node_observation(10,100,1,"/node","/reader","-","/test.ts","/host.ts");}\n')
            compiled = subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(Path(__file__).parent), str(source), '-o', str(binary)], capture_output=True, text=True, timeout=10)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            for mode, expected in ((0, None), (1, 'procargs_read'), (2, 'argc_bound'), (3, 'unsupported_flag:--eval'), (4, 'cwd_read'), (5, 'entry_mismatch'), (6, 'sandbox_read'), (7, 'sandbox_read')):
                result = subprocess.run([str(binary), str(mode)], capture_output=True, text=True, timeout=2)
                self.assertEqual(result.returncode, 0 if expected is None else 4, result.stderr)
                if expected is not None:
                    self.assertIn(expected, result.stderr)
                self.assertNotIn('DO_NOT_SURFACE', result.stdout + result.stderr)
                self.assertNotIn('ENV_SECRET', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
