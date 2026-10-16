import errno
import unittest

from policy import closing_verdict, error_verdict, wal_mtime_only, preexec_verdict, flake_verdict,update_fd_prior,namespace_pid,mapping_coverage,probe_failed,pid_observation
from gate import fake_env, lab_home, socket_path_lengths

HOME = '/home/lab'
HIVE = HOME + '/.hive'
META = dict(inode=1, size=100, mtime_ns=10000000000, mode=33152, uid=1000, gid=1000, type='file')


class PolicyTests(unittest.TestCase):
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
        self.assertEqual(self.error(before='S', after='Z', number=errno.EACCES), 'FAIL')

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
        for before, after, start, expected in [('Z','Z','12',True),('R','Z','12',True),('S','Z','12',False),('Z',None,None,True),('R','S','12',False),('Z','R','12',False),('Z','Z','13',False)]:
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


if __name__ == '__main__':
    unittest.main()
