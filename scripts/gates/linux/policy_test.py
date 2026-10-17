import errno
import unittest
import contextlib
import io
import os
import pathlib
import posixpath
from types import SimpleNamespace
from unittest.mock import patch

from policy import closing_verdict, error_verdict, wal_mtime_only, preexec_verdict, flake_verdict,update_fd_prior,namespace_pid,mapping_coverage,probe_failed,pid_observation
from gate import fake_env, lab_home, socket_path_lengths
from home_guard import home_guard, entry_guard, pull_destination, PROVIDER_DIRS, PROVIDER_KEYS, APIARY_DIRS
from thread_records import ThreadRecords
from birth_identity import birth_identity, parent_chain
from test_capabilities import assert_capabilities, capability_receipt_valid, SETPRIV_ARGS, CAPABILITY_SETS
from policy import RULE_VERSION
from filesystem import assert_filesystem, filesystem_probes

HOME = '/home/lab'
HIVE = HOME + '/.hive'
META = dict(inode=1, size=100, mtime_ns=10000000000, mode=33152, uid=1000, gid=1000, type='file')


class PolicyTests(unittest.TestCase):
    def test_workload_cannot_write_outside_run_root_and_devices_work(self):
        root = pathlib.Path(__file__).parent
        record = dict(state=assert_filesystem(root), probes=filesystem_probes(root))
        (pathlib.Path(os.environ['HOME']) / 'filesystem-tests.json').write_text(__import__('json').dumps(record))
        self.assertTrue(record['state']['asserted'])
        self.assertTrue(record['probes']['asserted'])
        self.assertTrue(record['probes']['devNull'])
        self.assertTrue(record['probes']['devUrandom'])
        self.assertTrue(record['probes']['ptyAllocation'])
        self.assertEqual({probe['operation'] for probe in record['probes']['privilegeProbes']},{'remount-proc-rw','remount-root-rw','umount-tmp','unshare-mount'})
        self.assertTrue(all(probe['refused'] for probe in record['probes']['privilegeProbes']))
        for probe in record['probes']['mkdir']:
            self.assertIn(probe['errno'], (errno.EACCES, errno.EROFS))

    def test_birth_stat_parent_survives_dead_status_13f09289(self):
        first = dict(state='Z', ppid=36, starttime='307527235')
        birth = dict(pid=27349, **birth_identity(first, dict(State='X (dead)', PPid='0', NSpid='0'), dict(user='user:[lab]', mnt='mnt:[lab]'), dict(errno=errno.ENOENT)))
        births = {27349: birth, **{pid: dict(ppid=parent) for pid, parent in ((36,29),(29,28),(28,7),(7,5),(5,1))}}
        scoped, chain = parent_chain(27349, births)
        birth.update(ownTreeAtFirstSight=scoped, parentChain=chain, nextBirthSample=dict(state='pid_gone'))
        self.assertEqual(chain, [27349,36,29,28,7,5,1])
        self.assertEqual(birth['ppid'], 36)
        self.assertEqual(birth['procStat'], first)
        self.assertEqual(birth['rawStatus']['PPid'], '0')
        self.assertFalse(birth['supplementalIdentityAccepted'])
        self.assertEqual(birth['NSpid'], [])
        self.assertEqual(birth['namespaces'], {})
        for unused in range(17):
            error = dict(slot='fd/4', errno=errno.ENOENT, atErrorStat=first, nextSample=dict(state='pid_gone'))
            self.assertEqual(error_verdict(error, birth, True, HIVE), 'scope_proven_exiting')
        self.assertEqual(mapping_coverage(birth, [], []), 'mapping unavailable: exited before host capture')

    def test_outside_birth_parent_cannot_be_replaced_by_status(self):
        first = dict(state='Z', ppid=999, starttime='307527235')
        birth = dict(pid=27349, **birth_identity(first, dict(State='Z', PPid='36', NSpid='27349'), {}, first))
        scoped, chain = parent_chain(27349, {27349: birth, 36: dict(ppid=1)})
        birth.update(ownTreeAtFirstSight=scoped, parentChain=chain, nextBirthSample=dict(state='pid_gone'))
        self.assertEqual(birth['ppid'], 999)
        self.assertFalse(scoped)
        self.assertEqual(error_verdict(dict(slot='fd/4',errno=errno.ENOENT,atErrorStat=first,nextSample=dict(state='pid_gone')), birth, True, HIVE), 'FAIL')
        self.assertEqual(mapping_coverage(birth, [], []), 'FAIL')

    def test_supplemental_identity_never_replaces_birth_start(self):
        first = dict(state='S', ppid=36, starttime='7')
        status = dict(State='S', PPid='36', NSpid='111 12')
        links = dict(user='user:[1]', mnt='mnt:[2]', net='net:[3]', pid='pid:[4]')
        valid = birth_identity(first, status, links, first)
        self.assertEqual(valid['NSpid'], [111,12])
        self.assertEqual(valid['namespaces'], links)
        for confirmation, later in ((dict(first,starttime='8'),status),(first,dict(status,NSpid='0')),(first,dict(status,State='X (dead)'))):
            record = birth_identity(first, later, links, confirmation)
            self.assertEqual(record['procStat']['starttime'], '7')
            self.assertFalse(record['supplementalIdentityAccepted'])
            self.assertEqual(record['NSpid'], [])
            self.assertEqual(record['namespaces'], {})

    def test_all_capabilities_dropped_in_every_set_with_no_new_privileges(self):
        fields = {key:'0000000000000000' for key in CAPABILITY_SETS}
        fields['NoNewPrivs'] = '1'
        assert_capabilities(fields)
        for key in CAPABILITY_SETS:
            for bit in (1,2,4,1<<21):
                with self.assertRaises(ValueError):
                    assert_capabilities(dict(fields, **{key:format(int(fields[key],16)|bit,'x')}))
        with self.assertRaises(ValueError):
            assert_capabilities(dict(fields,NoNewPrivs='0'))

    def test_capability_receipt_binds_helper_hash_argv_sets_and_guard(self):
        digest='a'*64
        config=dict(toolHashes={'test_capabilities.py':digest},runRoot='/runroot')
        command=['npm','test']
        record=dict(asserted=True,uid=1000,gid=1000,uidMap='1000 0 1',gidMap='1000 0 1',helperSha256=digest,execArgv=['python3','-B','/runroot/workload.py','/runroot','candidate-step0-0',*command],setprivArgv=SETPRIV_ARGS,command=command,status={**{key:'0' for key in CAPABILITY_SETS},'NoNewPrivs':'1'},entryGuard=dict(allowed=True,beforeFirstWrite=True,ruleVersion=RULE_VERSION))
        self.assertTrue(capability_receipt_valid(record,config,command,'candidate-step0-0'))
        for missing in ('helperSha256','setprivArgv','command','status','entryGuard','asserted','execArgv','uid','gid','uidMap','gidMap'):
            changed=dict(record);del changed[missing]
            self.assertFalse(capability_receipt_valid(changed,config,command,'candidate-step0-0'))
        for updates in (dict(uid=0),dict(gid=0),dict(uidMap='0 0 1'),dict(gidMap='0 0 1'),dict(helperSha256='b'*64),dict(execArgv=['other']),dict(setprivArgv=['setpriv','--no-new-privs']),dict(command=['npm','run','build']),dict(asserted=False),dict(entryGuard=dict(record['entryGuard'],beforeFirstWrite=False))):
            self.assertFalse(capability_receipt_valid(dict(record,**updates),config,command,'candidate-step0-0'))
        for key in CAPABILITY_SETS:
            fields=dict(record['status']);del fields[key]
            self.assertFalse(capability_receipt_valid(dict(record,status=fields),config,command,'candidate-step0-0'))
            self.assertFalse(capability_receipt_valid(dict(record,status=dict(record['status'],**{key:'200000'})),config,command,'candidate-step0-0'))
        self.assertFalse(capability_receipt_valid(dict(record,status=dict(record['status'],NoNewPrivs='0')),config,command,'candidate-step0-0'))
        self.assertFalse(capability_receipt_valid(record,dict(toolHashes={},runRoot='/runroot'),command,'candidate-step0-0'))
        self.assertFalse(capability_receipt_valid(None,config,command,'candidate-step0-0'))

    def test_auto_title_preexec_exception_is_exact_and_identity_preserving(self):
        path = HIVE + '/v2/auto-title.json'
        change = dict(path=path,before=META,after=dict(META,mtime_ns=META['mtime_ns']+1))
        self.assertEqual(preexec_verdict(change,HOME)[0], 'WARN')
        for key in ('inode','size','uid','gid','mode'):
            self.assertEqual(preexec_verdict(dict(change,after=dict(change['after'],**{key:META[key]+1})),HOME)[0], 'FAIL')
        self.assertEqual(preexec_verdict(change,HOME,touched=[path])[0], 'FAIL')
        for other in (HIVE+'/auto-title.json',HIVE+'/v2/other.json',HIVE+'/v2/auto-title.json.other'):
            self.assertEqual(preexec_verdict(dict(change,path=other),HOME)[0], 'FAIL')

    def error(self, before='R', after='S', number=errno.ENOENT, prior=None, scoped=True, masked=True, next_birth='100'):
        record = dict(errno=number, fd='4', slot='fd/4', previousTarget=prior, atErrorStat=dict(state=before, starttime='100'), nextSample=dict(state='pid_present' if after else 'pid_gone', procStat=dict(state=after, starttime=next_birth) if after else None))
        return error_verdict(record, dict(cgroupSightingTime=1) if scoped else {}, masked, HIVE)

    def test_exiting_errors_need_scope(self):
        for number in (errno.EACCES, errno.ENOENT, errno.ESRCH, errno.EIO):
            self.assertEqual(self.error(after=None, number=number), 'scope_proven_exiting')
            self.assertEqual(self.error(after=None, number=number, scoped=False), 'FAIL')
        record=dict(errno=errno.EACCES,slot='fd',nextSample=dict(state='pid_gone'))
        self.assertEqual(error_verdict(record,dict(ownTreeAtFirstSight=True),True,HIVE),'scope_proven_exiting')
        self.assertEqual(error_verdict(record,dict(ownTreeAtFirstSight=False),True,HIVE),'FAIL')

    def test_zombie_and_running_to_zombie(self):
        self.assertEqual(self.error(before='Z', after='Z', number=errno.EACCES), 'scope_proven_exiting')
        self.assertEqual(self.error(before='R', after='Z', number=errno.EACCES), 'scope_proven_exiting')
        for state in ('S','D','T','t','I','P','K','W','X','x'):
            self.assertEqual(self.error(before=state, after='Z', number=errno.EACCES), 'scope_proven_exiting')

    def test_reuse_fails(self):
        self.assertEqual(self.error(before='Z', after='R'), 'FAIL')
        self.assertEqual(self.error(after='Z', next_birth='101'), 'FAIL')

    def test_live_fd_history(self):
        self.assertEqual(self.error(prior='/safe/file'), 'prior_target_outside_hive')
        self.assertEqual(self.error(prior=HIVE + '/core.sqlite3'), 'FAIL')
        self.assertEqual(self.error(), 'masked_unknown_prior_WARN')
        self.assertEqual(self.error(masked=False), 'FAIL')
        self.assertEqual(self.error(number=errno.EACCES), 'FAIL')

    def test_preexec_wal_exception_is_exact(self):
        new = dict(META, mtime_ns=META['mtime_ns'] + 1)
        for name in ('core.sqlite3-wal', 'core.sqlite3-shm'):
            self.assertTrue(wal_mtime_only(HIVE + '/v2/' + name, META, new, HOME))
            for key in ('inode', 'size', 'uid', 'gid', 'mode'):
                self.assertFalse(wal_mtime_only(HIVE + '/v2/' + name, META, dict(new, **{key: META[key]+1}), HOME))
        self.assertFalse(wal_mtime_only(HIVE + '/v2/hived.log', META, new, HOME))

    def closing(self, path, new=None, eligible=True, times=(), touched=()):
        change = dict(path=path, before=dict(META, type=(new or META)['type']), after=new or dict(META, mtime_ns=11000000000))
        return closing_verdict(change, HOME, eligible, True, times, touched, [])

    def test_mask_does_not_clear_core_replacement_or_shrink(self):
        for new in (dict(META, inode=2), dict(META, size=99)):
            self.assertEqual(self.closing(HIVE + '/v2/core.sqlite3', new), 'FAIL')
        self.assertEqual(self.closing(HIVE + '/v2/core.sqlite3', dict(META, size=101)), 'WARN')
        self.assertEqual(self.closing(HIVE + '/v2/session-logs'), 'WARN')
        self.assertEqual(self.closing(HIVE + '/v2/session-logs', eligible=False), 'FAIL')

    def test_config_interim_rule(self):
        path = HIVE + '/v2/config.json'
        self.assertEqual(self.closing(path), 'FAIL')
        self.assertEqual(self.closing(path, times=[11]), 'WARN')
        self.assertEqual(self.closing(path, times=[14]), 'FAIL')

    def test_unnamed_dotdir_requires_no_touch(self):
        new = dict(META, type='directory')
        self.assertEqual(self.closing(HOME + '/.nectar', new), 'WARN')
        self.assertEqual(self.closing(HOME + '/.nectar', new, touched=[HOME + '/.nectar/file']), 'FAIL')

    def test_preexec_v24_classes_and_boundaries(self):
        for path, old, new in ((HIVE + '/v2/hived.log', META, dict(META, size=101)), (HIVE + '/v2/runners', dict(META, type='directory'), dict(META, type='directory', mtime_ns=11000000000))):
            change = dict(path=path, before=old, after=new)
            self.assertEqual(preexec_verdict(change, HOME)[0], 'WARN')
            self.assertEqual(preexec_verdict(change, HOME, touched=[path])[0], 'FAIL')
            self.assertEqual(preexec_verdict(change, HOME, named=[path])[0], 'FAIL')
            for key in ('inode', 'uid', 'gid', 'mode'):
                altered = dict(change, after=dict(new, **{key: old[key]+1}))
                self.assertEqual(preexec_verdict(altered, HOME)[0], 'FAIL')
            self.assertEqual(preexec_verdict(dict(change, before=None), HOME)[0], 'FAIL')
            self.assertEqual(preexec_verdict(dict(change, after=None), HOME)[0], 'FAIL')
        for path in (HOME + '/.nectar', HIVE, HIVE + '/v2/core.sqlite3', HIVE + '/v2/runners/child'):
            change = dict(path=path, before=dict(META, type='directory'), after=dict(META, type='directory', mtime_ns=11000000000))
            self.assertEqual(preexec_verdict(change, HOME)[0], 'FAIL')
        self.assertEqual(preexec_verdict(dict(path=HIVE + '/v2/hived.log', before=META, after=dict(META, size=99)), HOME)[0], 'FAIL')

    def test_flake_requires_complete_guarded_candidate_and_base(self):
        rows = [dict(physical=dict(version=version, attemptId=version+str(n)), guardAccepted=True,testEvidence=dict(exists=True,testFailure=True), testExit=1 if n==0 else 0) for version in ('candidate', 'base') for n in range(3)]
        self.assertEqual(flake_verdict(rows, 3)['classification'], 'flake evidence')
        for updates in (dict(guardAccepted=False), dict(testExit=None),dict(testEvidence=dict(exists=False,testFailure=True)),dict(testEvidence=dict(exists=True,testFailure=False))):
            broken = [dict(row) for row in rows]
            broken[0].update(updates)
            self.assertEqual(flake_verdict(broken, 3)['classification'], 'no flake attribution')
        self.assertEqual(flake_verdict(rows[:-1], 3)['classification'], 'no flake attribution')
        for row in rows:
            if row['physical']['version']=='base':row['testExit']=0
        self.assertEqual(flake_verdict(rows, 3)['classification'], 'no flake attribution')

    def test_fd_prior_invalidates_closed_incarnation(self):
        prior={'4':'/safe/file'}
        prior=update_fd_prior(prior,{},True)
        self.assertIsNone(prior.get('4'))
        self.assertEqual(update_fd_prior({'4':'/safe/file'},{},False),{'4':'/safe/file'})
        self.assertEqual(update_fd_prior(prior,{'4':'/new/file'},True),{'4':'/new/file'})

    def test_pid_mapping_uses_lab_level(self):
        self.assertIsNone(namespace_pid([123]))
        self.assertEqual(namespace_pid([123,4]),4)
        self.assertEqual(namespace_pid([123,4,1]),4)

    def test_mapping_missing_after_birth_exit_is_explicit(self):
        birth=dict(pid=4,procStat={})
        self.assertEqual(mapping_coverage(birth,[],[]),'FAIL')
        errors=[dict(pid=4,slot='firstSightStat',verdict='scope_proven_exiting')]
        birth.update(ownTreeAtFirstSight=True,nextBirthSample=dict(state='pid_gone'))
        self.assertEqual(mapping_coverage(birth,[],errors),'mapping unavailable: exited before host capture')
        birth['procStat']['starttime']='12'
        self.assertEqual(mapping_coverage(birth,[],errors),'mapping unavailable: exited before host capture')
        birth['nextBirthSample']['state']='pid_present'
        self.assertEqual(mapping_coverage(birth,[],errors),'FAIL')
        self.assertEqual(mapping_coverage(birth,[dict(namespacePid=4,starttime='12')],errors),'mapped')

    def test_probe_failure_aborts_invocation(self):
        valid=dict(childExit=0,probes=[dict(expectedFailure=True) for unused in range(3)])
        self.assertFalse(probe_failed(None))
        self.assertFalse(probe_failed(valid))
        self.assertTrue(probe_failed(dict(valid,childExit=2)))
        self.assertTrue(probe_failed(dict(valid,probes=valid['probes'][:-1])))
        self.assertTrue(probe_failed(dict(valid,probes=[dict(expectedFailure=False)]+valid['probes'][1:])))

    def test_mapping_and_read_errors_share_exit_evidence(self):
        for before, after, start, expected in [('Z','Z','12',True),('R','Z','12',True),('S','Z','12',True),('D','Z','12',True),('Z',None,None,True),('R','S','12',False),('Z','R','12',False),('Z','Z','13',False)]:
            birth=dict(pid=4893,ownTreeAtFirstSight=True,procStat=dict(state=before,starttime='12'))
            observation=dict(state='pid_present' if after else 'pid_gone',procStat=dict(state=after,starttime=start) if after else {})
            birth['nextBirthSample']=observation
            error=dict(slot='ns/mnt',errno=errno.ENOENT,atErrorStat=birth['procStat'],nextSample=observation)
            self.assertEqual(error_verdict(error,birth,True,HIVE)=='scope_proven_exiting',expected)
            self.assertEqual(mapping_coverage(birth,[],[])=='mapping unavailable: exited before host capture',expected)
            birth['ownTreeAtFirstSight']=False
            self.assertEqual(mapping_coverage(birth,[],[]),'FAIL')

    def test_short_lab_paths_and_socket_byte_budget(self):
        root='/home/trmd/.cache/hbl/12345678'
        home=lab_home(root,36)
        env=fake_env(home,'/usr/bin:/bin')
        self.assertEqual(env['HIVE_REAL_HOME'],env['HOME'])
        for key,value in env.items():
            if key not in ('PATH','LANG'):
                self.assertTrue(value.startswith(root+'/'))
        self.assertLessEqual(len(env['TMPDIR'].encode()),48)
        socket=env['TMPDIR']+'/hive-drv-ras-poll-12nKM9/poll-idle.sock'
        self.assertTrue(socket_path_lengths([socket])[0]['fits'])
        old='/home/trmd/.cache/hbl/261016142406-8fba30/homes/candidate-step6-0/tmp/hive-drv-ras-poll-12nKM9/poll-idle.sock'
        record=socket_path_lengths([old])[0]
        self.assertEqual(record['encodedBytes'],109)
        self.assertFalse(record['fits'])
        self.assertEqual(socket_path_lengths(['/é.sock'])[0]['encodedBytes'],8)

    def test_next_stat_enoent_overrides_stale_tree_listing(self):
        stat=dict(error='FileNotFoundError',errno=errno.ENOENT)
        observation=pid_observation(True,stat)
        self.assertTrue(observation['treeListed'])
        self.assertTrue(observation['statEnoent'])
        self.assertEqual(observation['procStat'],stat)
        self.assertEqual(observation['state'],'pid_gone')
        birth=dict(pid=5602,ownTreeAtFirstSight=True,procStat=dict(state='R',starttime='12'),nextBirthSample=observation)
        error=dict(slot='fd/41',fd='41',errno=errno.ENOENT,previousTarget='socket:[123]',atErrorStat=dict(state='S',starttime='12'),nextSample=observation)
        self.assertEqual(error_verdict(error,birth,True,HIVE),'scope_proven_exiting')
        self.assertEqual(mapping_coverage(birth,[],[]),'mapping unavailable: exited before host capture')
        for number in (errno.EACCES,errno.EIO):
            current=pid_observation(True,dict(errno=number))
            self.assertEqual(current['state'],'pid_present')
            self.assertEqual(error_verdict(dict(error,nextSample=current),birth,True,HIVE),'FAIL')
        self.assertEqual(pid_observation(False,None,False)['state'],'pid_gone')
        self.assertEqual(pid_observation(False,None,True)['state'],'pid_outside_scope')

    def test_raw_r16_sleeping_runner_exit(self):
        birth=dict(pid=8292,ownTreeAtFirstSight=True,procStat=dict(state='R',starttime='303018549'))
        observation=dict(state='pid_present',procStat=dict(state='Z',starttime='303018549'))
        error=dict(pid=8292,fd='28',slot='fd/28',errno=errno.ENOENT,previousTarget=None,atErrorStat=dict(state='S',starttime='303018549'),nextSample=observation)
        self.assertEqual(error_verdict(error,birth,True,HIVE),'scope_proven_exiting')
        birth['nextBirthSample']=observation
        self.assertEqual(mapping_coverage(birth,[],[]),'mapping unavailable: exited before host capture')
        error['nextSample']=dict(state='pid_present',procStat=dict(errno=errno.ENOENT))
        self.assertEqual(error_verdict(error,birth,True,HIVE),'scope_proven_exiting')

    def thread_case(self, tgid=8927, tid=8991):
        records=ThreadRecords()
        birth=records.observe(tgid,tid,dict(state='R',starttime='77'),1,10,'pid:[lab]')
        records.scope({tgid:dict(ownTreeAtFirstSight=True,parentChain=[tgid,1],procStat=dict(starttime='55'))})
        error=dict(pid=tid,tid=tid,tgid=tgid,threadScoped=True,slot='children',errno=errno.ENOENT,fd=None,sample=1,atErrorStat=dict(errno=errno.ENOENT))
        return records,birth,error

    def test_thread_gone_uses_tid_even_with_live_parent(self):
        records,birth,error=self.thread_case()
        calls=[]
        def read(tgid,tid):
            calls.append((tgid,tid));return dict(errno=errno.ENOENT)
        error['nextSample']=records.next_observation(8927,8991,2,11,read)
        self.assertEqual(calls,[(8927,8991)])
        self.assertEqual(error_verdict(error,birth,True,HIVE),'scope_proven_exiting')
        self.assertEqual(birth['procStat']['starttime'],'77')
        self.assertEqual(birth['nextBirthSample']['tid'],8991)
        self.assertEqual(birth['nextBirthSample']['state'],'pid_gone')

    def test_thread_z_same_identity_and_reuse(self):
        records,birth,error=self.thread_case()
        records.observe(8927,8991,dict(state='Z',starttime='77'),2,11)
        error['nextSample']=records.next_observation(8927,8991,2,11,lambda *_:self.fail('observed TID should not be re-read'))
        self.assertEqual(error_verdict(error,birth,True,HIVE),'scope_proven_exiting')
        records.observe(8927,8991,dict(state='Z',starttime='78'),3,12)
        error['nextSample']=records.current[(8927,8991)]
        self.assertTrue(error['nextSample']['identityChanged'])
        self.assertEqual(error_verdict(error,birth,True,HIVE),'FAIL')

    def test_raw_r16_parent_observations_do_not_prove_thread_exit(self):
        for tgid,tid in ((8927,8991),(11247,11259)):
            records,birth,error=self.thread_case(tgid,tid)
            for observation in ({},dict(sample=2,state='pid_present',procStat=dict(state='S',starttime='77')),dict(sample=2,state='pid_gone',procStat=dict(errno=errno.ENOENT))):
                error['nextSample']=observation
                self.assertEqual(error_verdict(error,birth,True,HIVE),'FAIL')
            error['nextSample']=dict(sample=2,tid=tid,tgid=tgid,state='pid_present',procStat=dict(state='S',starttime='77'))
            self.assertEqual(error_verdict(error,birth,True,HIVE),'FAIL')

    def test_thread_unknown_identity_and_scope_fail_closed(self):
        records,birth,error=self.thread_case()
        error['nextSample']=records.next_observation(8927,8991,2,11,lambda *_:dict(errno=errno.EACCES))
        self.assertEqual(error_verdict(error,birth,True,HIVE),'FAIL')
        error['nextSample']=dict(sample=2,tid=8991,tgid=8927,state='pid_present',procStat=dict(state='Z'))
        self.assertEqual(error_verdict(error,birth,True,HIVE),'FAIL')
        error['nextSample']=dict(sample=2,tid=8991,tgid=8927,state='pid_gone')
        birth['ownTreeAtFirstSight']=False
        self.assertEqual(error_verdict(error,birth,True,HIVE),'FAIL')

    def test_thread_exit_before_birth_stat_is_retained(self):
        records=ThreadRecords()
        birth=records.observe(10,11,dict(errno=errno.ENOENT),1,10)
        records.scope({10:dict(ownTreeAtFirstSight=True,parentChain=[10,1],procStat=dict(starttime='4'))})
        error=dict(pid=11,tid=11,tgid=10,threadScoped=True,slot='children',errno=errno.ENOENT,fd=None,sample=1,atErrorStat=dict(errno=errno.ENOENT),nextSample=records.next_observation(10,11,2,11,lambda *_:dict(errno=errno.ENOENT)))
        self.assertEqual(error_verdict(error,birth,True,HIVE),'scope_proven_exiting')

    def test_guard_refuses_each_sensitive_home_and_variable(self):
        real='/home/unit-passwd'
        allowed=dict(HOME=real+'/.cache/hbl/abc/h/0',TMPDIR=real+'/.cache/hbl/abc/h/0/t')
        for name in ('HOME','TMPDIR','XDG_CONFIG_HOME','XDG_RUNTIME_DIR','XDG_CUSTOM_LOCATION'):
            for target in (real,*[real+'/'+directory for directory in ('.hive','.config','Library',*PROVIDER_DIRS,*APIARY_DIRS)]):
                for value in (target,target+'/nested') if target!=real else (target,):
                    result=home_guard(dict(allowed,**{name:value}),[real],posixpath.normpath)
                    self.assertFalse(result['allowed'],(name,value))
                    self.assertEqual(result['offendingVariable'],name)

    def test_guard_resolves_symlinks_lists_and_prefix_boundaries(self):
        real='/home/unit-passwd';base=dict(HOME=real+'/.cache/hbl/lab',TMPDIR=real+'/.cache/hbl/lab/t')
        result=home_guard(dict(base,TMPDIR='/fake/link'),[real],lambda path:real+'/.hive/v2' if path=='/fake/link' else posixpath.normpath(path))
        self.assertEqual(result['offendingVariable'],'TMPDIR')
        self.assertEqual(home_guard(dict(base,XDG_DATA_DIRS='/safe:'+real+'/.config/data'),[real],posixpath.normpath)['offendingVariable'],'XDG_DATA_DIRS')
        self.assertFalse(home_guard(dict(base,HOME=real+'/.hive-other'),[real],posixpath.normpath)['allowed'])
        result=home_guard(dict(base,XDG_CONFIG_HOME='/volume/config/nested'),[real],lambda path:'/volume/config' if path==real+'/.config' else posixpath.normpath(path))
        self.assertEqual(result['offendingVariable'],'XDG_CONFIG_HOME')

    def test_guard_requires_cache_or_run_root_for_home_tmp_and_all_xdg(self):
        real='/home/unit-passwd';root=real+'/.cache/hbl/abc'
        base=dict(HOME=root+'/h',TMPDIR=root+'/t')
        for name in ('HOME','TMPDIR','XDG_CONFIG_HOME','XDG_CUSTOM','XDG_DATA_DIRS'):
            for value in (real+'/lab',real+'/.cache/hbl-other',real+'/.cache/hbl/../elsewhere'):
                self.assertEqual(home_guard(dict(base,**{name:value}),[real],posixpath.normpath)['offendingVariable'],name)
            self.assertTrue(home_guard(dict(base,**{name:root+'/allowed'}),[real],posixpath.normpath)['allowed'])
        self.assertFalse(home_guard(dict(base,XDG_DATA_DIRS=root+':'+real+'/lab'),[real],posixpath.normpath)['allowed'])
        self.assertTrue(home_guard(dict(HOME='/isolated/run/h',TMPDIR='/isolated/run/t'),[real],posixpath.normpath,allowed_roots=['/isolated/run'])['allowed'])

    def test_guard_allowed_case_and_refusal_output_has_no_values(self):
        real='/home/unit-passwd';env=dict(HOME=real+'/.cache/hbl/lab',TMPDIR=real+'/.cache/hbl/lab/t',XDG_CONFIG_HOME=real+'/.cache/hbl/lab/config')
        self.assertTrue(home_guard(env,[real],posixpath.normpath)['allowed'])
        stream=io.StringIO()
        with patch('home_guard.pwd.getpwuid',return_value=SimpleNamespace(pw_dir=real)),patch('home_guard.os.environ',dict(env,HOME=real)),contextlib.redirect_stderr(stream):
            with self.assertRaises(SystemExit):entry_guard()
        self.assertEqual(stream.getvalue(),'refused unsafe HOME\n')
        self.assertNotIn(real,stream.getvalue())

    def test_pull_output_cannot_escape_or_share_local_script_name(self):
        self.assertEqual(pull_destination('/runroot','candidate-source.tar',{'mask.py','run.sh'}),pathlib.Path('/runroot/pull/candidate-source.tar'))
        for name in ('mask.py','run.sh','../mask.py','/elsewhere/cache.tar','sub/cache.tar','..',''):
            with self.assertRaises(ValueError):pull_destination('/runroot',name,{'mask.py','run.sh'})

    def test_guard_provider_overrides_and_missing_required_paths(self):
        real='/home/unit-passwd';env=dict(HOME=real+'/.cache/hbl/lab',TMPDIR=real+'/.cache/hbl/lab/t')
        for name in PROVIDER_KEYS:
            result=home_guard(dict(env,**{name:real+'/.hive/private'}),[real],posixpath.normpath)
            self.assertEqual(result['offendingVariable'],name)
        for missing in ('HOME','TMPDIR'):
            current=dict(env);del current[missing]
            self.assertEqual(home_guard(current,[real],posixpath.normpath)['offendingVariable'],missing)

    def test_controller_refusal_precedes_writes_and_lab_commands(self):
        from gate import main
        argv=['run.sh','--real-home','/home/unit-passwd','--candidate','candidate','--base','base','--steps','gate-tests','--npm-cache','cache','--npm-cache-sha256','digest']
        with patch('sys.argv',argv),patch('gate.entry_guard',side_effect=SystemExit(2)),patch('gate.pathlib.Path.mkdir') as mkdir,patch('gate.subprocess.check_output') as command:
            with self.assertRaises(SystemExit):main()
            mkdir.assert_not_called()
            command.assert_not_called()

    def test_guard_preserves_canonical_roots_after_home_overlay(self):
        real='/home/unit-passwd';env=dict(HOME=real+'/.cache/hbl/lab',TMPDIR=real+'/.cache/hbl/lab/t')
        outside=home_guard(env,[real],lambda path:'/volume/provider' if path==real+'/.codex' else posixpath.normpath(path))
        self.assertIn('/volume/provider',outside['protectedRoots'])
        inside=home_guard(dict(env,XDG_CUSTOM_HOME='/volume/provider/nested'),[real],posixpath.normpath,outside['protectedRoots'])
        self.assertEqual(inside['offendingVariable'],'XDG_CUSTOM_HOME')


if __name__ == '__main__':
    guard=entry_guard(pathlib.Path(__file__).parent)
    (pathlib.Path(os.environ['HOME'])/'entry-guard-tests.json').write_text(__import__('json').dumps(guard))
    unittest.main()
