import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import scope_controls
import focused_seal


class ScopeControlTests(unittest.TestCase):
    def test_positive_negative_write_and_observation_values_fail_closed(self):
        for sandboxed in (False, True):
            output = 'NODE /node\nENTRY /reader\nCWD /work\nSANDBOX ' + str(int(sandboxed)) + '\n'
            policy = 'CELL 0\nCONTENT ' + ('1' if sandboxed else '0') + '\nSEALED ' + ('1' if sandboxed else '0') + '\n'
            row = scope_controls.observation(output, '/node', '/reader', '/work', sandboxed, policy)
            self.assertTrue(row['environmentNeverSurfaced'])
            for bad_output, bad_policy in ((output.replace('CWD /work', 'CWD /wrong'), policy), (output.replace('ENTRY /reader', 'ENTRY /wrong'), policy), (output.replace('SANDBOX ' + str(int(sandboxed)), 'SANDBOX ' + str(int(not sandboxed))), policy), (output, 'CELL 1\nCONTENT 0\nSEALED 0\n'), ('', policy), (output + scope_controls.ENV_CANARY, policy)):
                with self.subTest(sandboxed=sandboxed), self.assertRaises(ValueError):
                    scope_controls.observation(bad_output, '/node', '/reader', '/work', sandboxed, bad_policy)

    def test_quiescence_reason_is_bounded_and_has_no_foreign_fields(self):
        reason = {'type': 'QuiescenceFailure', 'call': 'pidinfo vnode', 'errno': 'EPERM', 'errnoNumber': 1, 'sameBirth': 0, 'counts': {'scanned': 2, 'skippedGone': 0, 'skippedUidChanged': 0, 'skippedFdClosed': 0, 'matched': 0, 'failed': 1, 'exeUnlinkedPreRoot': 0, 'regionCompared': 0, 'regionUnavailable': 0, 'sessionLeaderNotUidListed': 0, 'fdUnobservableSandboxDenied': 0, 'fdNonGateFailed': 0, 'fdCleanFailed': 0, 'fdSandboxFailed': 0, 'fdDeniedQueries': 0, 'fdAllowedQueries': 0, 'fdQueryErrors': 0, 'fdNotSandboxed': 0, 'fdUnobservableWriteDenied': 0, 'fdUnobservablePlatformBinary': 0, 'notPlatform': 0, 'pathDisallowed': 0, 'csopsError': 0, 'inodeMatch': 0, 'platformInodeUnobserved': 0}}
        reason.update(fdAllowedByQuery=dict.fromkeys(('root:read', 'root:write', 'probe:read', 'probe:write', 'src:read', 'src:write', 'absent:read', 'absent:write', 'root:create', 'root:unlink', 'probe:create', 'probe:unlink', 'src:create', 'src:unlink', 'absent:create', 'absent:unlink'), 0), fdFailedQueryResults=[-2] * 16, fdWriteDeniedReadResults={slot: {'allowed': 0, 'denied': 0} for slot in ('root:read', 'probe:read', 'src:read', 'absent:read')})
        result = subprocess.CompletedProcess([], 4, '', json.dumps(reason))
        evidence = focused_seal.quiescence_evidence(result)
        self.assertEqual(evidence, {'exit': 4, 'reason': reason, 'fdUnobservableDisclosure': focused_seal.fd_disclosure(0), 'fdUnobservableWriteDeniedDisclosure': focused_seal.fd_write_disclosure(0), 'fdUnobservablePlatformBinaryDisclosure': focused_seal.fd_platform_disclosure(0)})
        result.stderr = json.dumps(dict(reason, path='/foreign/private'))
        self.assertEqual(focused_seal.quiescence_evidence(result)['reason'], {'type': 'UnobservedQuiescenceFailure'})
        result.stderr = 'x' * 4097
        self.assertEqual(focused_seal.quiescence_evidence(result)['reason'], {'type': 'UnobservedQuiescenceFailure'})

    def test_prelaunch_failure_and_receipt_retain_reason_and_exit(self):
        import guard
        reason = {'type': 'QuiescenceFailure', 'call': 'fdinfo', 'errno': 'EPERM', 'errnoNumber': 1, 'sameBirth': 0, 'counts': {'scanned': 1, 'skippedGone': 0, 'skippedUidChanged': 0, 'skippedFdClosed': 0, 'matched': 0, 'failed': 1, 'exeUnlinkedPreRoot': 0, 'regionCompared': 0, 'regionUnavailable': 0, 'sessionLeaderNotUidListed': 0, 'fdUnobservableSandboxDenied': 0, 'fdNonGateFailed': 0, 'fdCleanFailed': 0, 'fdSandboxFailed': 0, 'fdDeniedQueries': 0, 'fdAllowedQueries': 0, 'fdQueryErrors': 0, 'fdNotSandboxed': 0, 'fdUnobservableWriteDenied': 0, 'fdUnobservablePlatformBinary': 0, 'notPlatform': 0, 'pathDisallowed': 0, 'csopsError': 0, 'inodeMatch': 0, 'platformInodeUnobserved': 0}}
        reason.update(fdAllowedByQuery=dict.fromkeys(('root:read', 'root:write', 'probe:read', 'probe:write', 'src:read', 'src:write', 'absent:read', 'absent:write', 'root:create', 'root:unlink', 'probe:create', 'probe:unlink', 'src:create', 'src:unlink', 'absent:create', 'absent:unlink'), 0), fdFailedQueryResults=[-2] * 16, fdWriteDeniedReadResults={slot: {'allowed': 0, 'denied': 0} for slot in ('root:read', 'probe:read', 'src:read', 'absent:read')})
        result = subprocess.CompletedProcess([], 4, '', json.dumps(reason))
        with tempfile.TemporaryDirectory() as temporary, patch.object(focused_seal, 'QUIESCENCE_OBSERVATIONS', []), patch.object(focused_seal.subprocess, 'run', return_value=result):
            root = Path(temporary).resolve()
            focused_seal.ROOT_CREATION[str(root)] = {'beforeMkdirNs': 200000000000}
            (root / 'src').mkdir(exist_ok=True)
            (root / 'src/package.json').write_text('{}')
            (root / 't').mkdir(exist_ok=True)
            with self.assertRaisesRegex(ValueError, 'unresolved'):
                focused_seal.require_quiescent(root, root / 'scope')
            guard.write_json(root / 'receipt.json', {'exit': 90}, root)
            receipt = json.loads((root / 'receipt.json').read_text())
            self.assertEqual(receipt['quiescenceObservations'], [{'exit': 4, 'reason': reason, 'fdUnobservableDisclosure': focused_seal.fd_disclosure(0), 'fdUnobservableWriteDeniedDisclosure': focused_seal.fd_write_disclosure(0), 'fdUnobservablePlatformBinaryDisclosure': focused_seal.fd_platform_disclosure(0)}])
            self.assertEqual(receipt['fdUnobservableDisclosure'], focused_seal.fd_disclosure(0))

    def test_root_clock_and_inode_inventory_are_controller_owned_and_retained(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(focused_seal, 'ROOT_CREATION', {}), patch.object(focused_seal, 'ROOT_INODES', {}):
            root = Path(temporary).resolve()
            with self.assertRaisesRegex(ValueError, 'creation clock'):
                focused_seal.quiescence_input(root, root / 'scope')
            focused_seal.ROOT_CREATION[str(root)] = {'beforeMkdirNs': 200000000123}
            (root / 'src').mkdir(exist_ok=True)
            (root / 'src/package.json').write_text('{}')
            (root / 't').mkdir(exist_ok=True)
            file = root / 'binary'
            file.write_text('fixture')
            key = (file.stat().st_dev, file.stat().st_ino)
            command, inventory = focused_seal.quiescence_input(root, root / 'scope')
            self.assertEqual(command[-4], '200000000')
            self.assertIn(str(key[0]) + ' ' + str(key[1]), inventory)
            file.unlink()
            self.assertIn(str(key[0]) + ' ' + str(key[1]), focused_seal.quiescence_input(root, root / 'scope')[1])

    def test_own_launch_history_survives_exit_and_is_sent_over_stdin(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(focused_seal, 'GATE_LAUNCH_PIDS', set()), patch.object(focused_seal, 'GATE_LAUNCH_BIRTHS', set()):
            root = Path(temporary).resolve()
            focused_seal.ROOT_CREATION[str(root)] = {'beforeMkdirNs': 200000000000}
            (root / 'src').mkdir(exist_ok=True)
            (root / 'src/package.json').write_text('{}')
            (root / 't').mkdir(exist_ok=True)
            focused_seal.remember_launch(77)
            focused_seal.remember_birth(['88', '77', '100', '1'])
            focused_seal.remember_birth(['88', '77', '101', '1'])
            self.assertEqual(len(focused_seal.GATE_LAUNCH_BIRTHS), 2)
            command, inventory = focused_seal.quiescence_input(root, root / 'scope')
            self.assertTrue(inventory.endswith('2\n77\n88\n'))
            self.assertNotIn('77', command)

    def test_fd_disclosure_is_verbatim_with_scan_count(self):
        expected = "fd introspection denied by MAC for 3 same-uid sandboxed processes; accepted because each one's own sandbox denies read and write on the run root; an fd passed in over IPC by another process is not excluded."
        self.assertEqual(focused_seal.fd_disclosure(3), expected)
        self.assertEqual(focused_seal.fd_write_disclosure(2), "2 same-uid sandboxed processes with MAC-denied fd introspection may READ the run root; each one's own sandbox denies write and create on all probed root paths; integrity relies on that write denial plus N1 before/after hashing; read access and an fd passed in over IPC are not excluded.")
        self.assertEqual(focused_seal.fd_platform_disclosure(2), "2 same-uid Apple platform binaries with MAC-denied fd introspection were accepted by code-signing platform status and SIP-protected executable path; their open descriptors were not observed.")
        counts = dict.fromkeys(('scanned', 'skippedGone', 'skippedUidChanged', 'skippedFdClosed', 'matched', 'failed', 'exeUnlinkedPreRoot', 'regionCompared', 'regionUnavailable', 'sessionLeaderNotUidListed', 'fdUnobservableSandboxDenied', 'fdNonGateFailed', 'fdCleanFailed', 'fdSandboxFailed', 'fdDeniedQueries', 'fdAllowedQueries', 'fdQueryErrors', 'fdNotSandboxed', 'fdUnobservableWriteDenied', 'fdUnobservablePlatformBinary', 'notPlatform', 'pathDisallowed', 'csopsError', 'inodeMatch', 'platformInodeUnobserved'), 0)
        counts['fdUnobservableSandboxDenied'] = 3
        reason = {'type': 'QuiescenceComplete', 'call': 'none', 'errno': 'NONE', 'errnoNumber': 0, 'sameBirth': -1, 'counts': counts}
        reason.update(fdAllowedByQuery=dict.fromkeys(('root:read', 'root:write', 'probe:read', 'probe:write', 'src:read', 'src:write', 'absent:read', 'absent:write', 'root:create', 'root:unlink', 'probe:create', 'probe:unlink', 'src:create', 'src:unlink', 'absent:create', 'absent:unlink'), 0), fdFailedQueryResults=[-2] * 16, fdWriteDeniedReadResults={slot: {'allowed': 0, 'denied': 0} for slot in ('root:read', 'probe:read', 'src:read', 'absent:read')})
        evidence = focused_seal.quiescence_evidence(subprocess.CompletedProcess([], 0, 'COMPLETE\n', json.dumps(reason)))
        self.assertEqual(evidence['fdUnobservableDisclosure'], expected)

    @unittest.skipUnless(sys.platform == 'darwin', 'real controller scope controls run only on Darwin')
    def test_real_controller_controls_preceded_self_test_body(self):
        report = json.loads((Path(os.environ['GATE_ROOT']) / 'scope-control-self-tests.json').read_text())
        self.assertTrue(report['ok'])
        self.assertTrue(report['realDarwinControls'])
        self.assertFalse(report['nativeArtifactsBuilt'])
        self.assertEqual([row['node']['sandboxed'] for row in report['rows']], [False, True])
        self.assertTrue(all(row['ok'] and row['afterExitQuiescenceEmpty'] and row['environmentNeverSurfaced'] for row in report['rows']))
        self.assertTrue(report['rows'][0]['liveQuiescence']['detected'])
        self.assertTrue(report['rows'][0]['goneChildNotReported'])

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Apple zeroing branch stub compiles on Linux')
    def test_apple_memset_s_branch_checks_return_and_zeros_without_glibc(self):
        scope = Path(__file__).with_name('scope.c').read_text()
        prefix = scope[:scope.index('#ifdef __APPLE__')]
        helper = scope[scope.index('static void secure_zero('):scope.index('static int identity(')]
        source = prefix + r'''
#define __APPLE__ 1
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if !defined(__STDC_WANT_LIB_EXT1__) || __STDC_WANT_LIB_EXT1__ != 1
#error Annex K feature macro required before string.h
#endif
static int fail=0;
static int memset_s(void *p,size_t bound,int value,size_t count) { if(fail)return 22;if(bound!=count||value!=0)return 22;memset(p,value,count);return 0; }
#define explicit_bzero(...) forbidden_glibc_api_on_apple
''' + helper + r'''
int main(int argc,char **argv) { (void)argv;unsigned char data[64];memset(data,99,sizeof(data));fail=argc>1;secure_zero(data,sizeof(data));for(size_t i=0;i<sizeof(data);i++)if(data[i])return 9;return 0; }
'''
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / 'zero.c'
            file.write_text(source)
            binary = root / 'zero'
            result = subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(file), '-o', str(binary)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(subprocess.run([str(binary)], capture_output=True, timeout=2).returncode, 0)
            failed = subprocess.run([str(binary), 'fail'], capture_output=True, text=True, timeout=2)
            self.assertEqual(failed.returncode, 4)
            self.assertEqual(failed.stderr, 'secure zero failed\n')


if __name__ == '__main__':
    unittest.main()

