import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import focused_reader_barrier as module
import focused_flow
from focused_barrier import Barrier
from focused_roles import Roles
from focused_diagnostics import ROW_NAMES


class ReaderBarrierTests(unittest.TestCase):
    def setup_barrier(self, root):
        control=root/'control';control.mkdir(mode=0o700)
        workspace=root/'src';workspace.mkdir()
        fixture=root/'fr-abcdef';fixture.mkdir(mode=0o700)
        (fixture/'work').mkdir(mode=0o700)
        node='node'; host='host'; reader='reader'
        roles=Roles(11,{node:'test-runner',host:'runner-host-main',reader:'reader'},False)
        births=[('11','1','100','1'),('12','11','101','1'),('13','12','102','1'),('14','13','103','1')]
        for birth,entry in zip(births,(node,node,host,reader)):roles.observe(birth,entry)
        profile=str(fixture/'work/sandbox.sb')
        paths={'cellDir':str(fixture/'work'),'deliveryContent':str(fixture/'content'),'sealedRoot':str(workspace.parent)}
        Path(profile).write_bytes(b'profile');Path(profile).chmod(0o600)
        from focused_profile import profile_state
        record={'expected':b'profile','state':profile_state(profile,b'profile'),'layout':{'fixtureRoot':str(fixture),'profile':profile,'cwd':str(fixture/'work')},'content':str(fixture/'content'),'livePolicies':[{'birth':list(births[-1]),'policy':{'cellDir':'allowed','deliveryContent':'denied','sealedRoot':'denied'},'probePaths':paths}]}
        mediation=SimpleNamespace(row_id=ROW_NAMES['cell-sandbox'],helper=root/'scope',workspace=workspace,reader=reader,roles=roles,records={profile:record},observed={births[-1]:profile},recipient_births={births[-1]:list(births[-1])})
        barrier=module.ReaderBarrier(control,'o-p0.sock',mediation,clock=lambda:0)
        self.addCleanup(barrier.close)
        retained={index:list(birth) for index,birth in enumerate(births)}
        message=(json.dumps({'version':1,'operation':'reader-observed','rowId':mediation.row_id,'fixtureRoot':str(fixture)})+'\n').encode()
        return barrier,mediation,fixture,retained,message

    def connect(self, barrier, message):
        client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);client.connect(str(barrier.path));client.sendall(message);client.settimeout(1)
        self.addCleanup(client.close)
        return client

    def test_no_client_is_inert_and_original_names_stay_exact(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();barrier,mediation,_,retained,_=self.setup_barrier(root)
            with patch('focused_reader_barrier.subprocess.run') as invoked:
                barrier.drain(retained);verdict=barrier.finish(retained)
            self.assertTrue(verdict['ok']);self.assertFalse(verdict['enabled']);invoked.assert_not_called()
            with self.assertRaisesRegex(ValueError,'barrier_name'):Barrier(root/'control','o-p1.sock',mediation)
            self.assertNotIn(module.ENV, module.focused_barrier.environment({}))

    def test_complete_own_row_ack_and_peer_eof(self):
        with tempfile.TemporaryDirectory() as temporary:
            barrier,_,_,retained,message=self.setup_barrier(Path(temporary).resolve());client=self.connect(barrier,message)
            with patch('focused_barrier.authenticate',return_value=True),patch('focused_reader_barrier.subprocess.run',return_value=subprocess.CompletedProcess([],0,'same-birth-alive','')) as invoked:
                barrier.drain(retained)
                self.assertEqual(client.recv(256),module.ACK);self.assertEqual(client.recv(1),b'')
                client.close();barrier.drain(retained)
            self.assertTrue(barrier.finish(retained)['ok']);self.assertTrue(barrier.evidence()['readerStillLiveAtAck']);self.assertEqual(invoked.call_args.args[0][1],'status')

    def test_missing_observation_returns_without_blocking_then_times_out(self):
        with tempfile.TemporaryDirectory() as temporary:
            barrier,mediation,_,retained,message=self.setup_barrier(Path(temporary).resolve());mediation.observed.clear();client=self.connect(barrier,message)
            with patch('focused_barrier.authenticate',return_value=True),patch('focused_reader_barrier.subprocess.run') as invoked:
                barrier.drain(retained);invoked.assert_not_called();self.assertFalse(barrier.sent)
                barrier.clock=lambda:16
                with self.assertRaisesRegex(ValueError,'timeout'):barrier.drain(retained)
            self.assertFalse(barrier.evidence()['ok'])

    def test_each_binding_condition_refuses_or_waits_without_ack(self):
        for case in ('profile','other-profile','missing-policy','bad-policy','changed-profile','wrong-parent','missing-birth','wrong-entry','gone','changed','peer','wrong-row','malformed','duplicate-key','second','early-eof'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as temporary:
                barrier,mediation,fixture,retained,message=self.setup_barrier(Path(temporary).resolve())
                if case=='profile':mediation.records.clear()
                if case=='other-profile':mediation.observed[('14','13','103','1')]='other'
                if case=='missing-policy':next(iter(mediation.records.values()))['livePolicies']=[]
                if case=='bad-policy':next(iter(mediation.records.values()))['livePolicies'][0]['policy']['cellDir']='denied'
                if case=='changed-profile':(fixture/'work/sandbox.sb').write_bytes(b'changed')
                if case=='wrong-parent':mediation.roles.identities[13]=( ('13','99','102','1'),'runner-host-main','host')
                if case=='missing-birth':retained.pop(3)
                if case=='wrong-entry':mediation.reader='other'
                if case=='wrong-row':message=message.replace(ROW_NAMES['cell-sandbox'].encode(),ROW_NAMES['satellite-default'].encode())
                if case=='malformed':message=b'{}\n'
                if case=='duplicate-key':message=b'{"version":1,"version":1}\n'
                client=self.connect(barrier,message)
                if case=='second':self.connect(barrier,message)
                if case=='early-eof':client.close()
                peer=ValueError('peer_birth') if case=='peer' else None
                status=3 if case=='gone' else 4 if case=='changed' else 0
                with patch('focused_barrier.authenticate',side_effect=peer,return_value=True),patch('focused_reader_barrier.subprocess.run',return_value=subprocess.CompletedProcess([],status,'','')):
                    if case in ('other-profile','missing-policy','wrong-entry'):
                        barrier.drain(retained);self.assertFalse(barrier.sent)
                        continue
                    with self.assertRaises(ValueError):barrier.drain(retained)
                self.assertFalse(barrier.evidence()['ok'])

    def test_send_and_shutdown_errors_fail_and_partial_sends_recheck_birth(self):
        class SocketProxy:
            def __init__(self, actual, mode):self.actual=actual;self.mode=mode
            def __getattr__(self, name):return getattr(self.actual,name)
            def send(self, data):
                if self.mode=='send':raise OSError('forced')
                return self.actual.send(data[:1] if self.mode=='partial' else data)
            def shutdown(self, how):
                if self.mode=='shutdown':raise OSError('forced')
                return self.actual.shutdown(how)
        for mode in ('send','shutdown','partial'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as temporary:
                barrier,mediation,_,retained,message=self.setup_barrier(Path(temporary).resolve())
                observed=dict(mediation.observed);mediation.observed.clear();client=self.connect(barrier,message)
                with patch('focused_barrier.authenticate',return_value=True),patch('focused_reader_barrier.subprocess.run',return_value=subprocess.CompletedProcess([],0,'','')) as invoked:
                    barrier.drain(retained);mediation.observed.update(observed);barrier.connection=SocketProxy(barrier.connection,mode)
                    if mode=='partial':
                        barrier.drain(retained);self.assertEqual(client.recv(1),module.ACK[:1]);self.assertFalse(barrier.sent)
                        invoked.return_value=subprocess.CompletedProcess([],4,'','')
                        with self.assertRaisesRegex(ValueError,'reader-gone'):barrier.drain(retained)
                    else:
                        with self.assertRaises(ValueError):barrier.drain(retained)
                    self.assertFalse(barrier.evidence()['ok'])

    def test_connection_classification_uses_only_two_exact_endpoints(self):
        birth=['11','1','100','1']
        rows=[subprocess.CompletedProcess([],0,'3 UNIX gate-barrier 0\n',''),subprocess.CompletedProcess([],0,'4 UNIX gate-barrier 0\n','')]
        with patch('focused_flow.subprocess.run',side_effect=rows) as invoked:
            result=focused_flow.connection_observation('/scope',birth,'/control/b-p0.sock','/control/o-p0.sock')
        self.assertEqual([call.args[0][-1] for call in invoked.call_args_list],['/control/b-p0.sock','/control/o-p0.sock'])
        self.assertEqual([row['classification'] for row in result['connections']],['gate-barrier','gate-observation-barrier'])
        with patch('focused_flow.subprocess.run',return_value=rows[0]),self.assertRaises(ValueError):focused_flow.connection_observation('/scope',birth)

    def test_instrumented_and_env_collision_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            barrier,mediation,_,_,_=self.setup_barrier(Path(temporary).resolve())
            with self.assertRaises(ValueError):barrier.environment({module.ENV:'collision'})
            with self.assertRaises(ValueError):module.ReaderBarrier(barrier.directory,'o-p1.sock',mediation)
            mediation.row_id='unreviewed'
            with self.assertRaises(ValueError):module.ReaderBarrier(barrier.directory,'o-p1.sock',mediation)


if __name__ == "__main__":
    unittest.main()
