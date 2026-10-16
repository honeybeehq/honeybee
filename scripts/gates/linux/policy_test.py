import errno
import unittest

from policy import closing_verdict, error_verdict, wal_mtime_only

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


if __name__ == '__main__':
    unittest.main()
