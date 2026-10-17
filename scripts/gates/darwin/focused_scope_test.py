from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform.startswith('linux'), 'group C stub compiles on Linux only')
class ScopeTests(unittest.TestCase):
    def test_group_byte_counts_and_exact_member_births_before_signal(self):
        source = Path(__file__).with_name('scope.c').read_text()
        function = source[source.index('static int group_members('):source.index('typedef int (*sandbox_check_function)')]
        stub = r'''#include <sys/types.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#define PROC_PGRP_ONLY 2
struct proc_bsdinfo { unsigned int pbi_pgid; unsigned long long pbi_start_tvsec, pbi_start_tvusec; };
static int mode=0, killed=0;
static int same_birth(int pid,unsigned long long sec,unsigned long long usec) { (void)pid;(void)sec;(void)usec;return 0; }
static int identity(int pid,struct proc_bsdinfo *b) { b->pbi_pgid=11;b->pbi_start_tvsec=pid+90;b->pbi_start_tvusec=pid-9;if(mode==3&&pid==12)b->pbi_start_tvsec=999;return 1; }
static void print_identity(int pid,struct proc_bsdinfo *b) { (void)pid;(void)b; }
static int proc_listpids(unsigned int type,unsigned int group,void *buffer,int capacity) {
  (void)type;(void)group;
  int members[]={11,12,13};int size=(mode==1?3:2)*(int)sizeof(int);
  if(mode==2) { errno=EPERM;return 0; }
  if(buffer) { if(capacity<size)return -1;memcpy(buffer,members,size); }
  return size;
}
static int fake_kill(int pid,int sig) { if(sig!=SIGKILL)return -1;killed=pid;return 0; }
#define kill fake_kill
'''
        main = r'''
int main(void) {
  char *allowed[]={"11:101:2","12:102:3"};
  if(group_members(11,101,2,SIGKILL,2,allowed)!=0||killed!=-11)return 1;
  for(mode=1;mode<=3;mode++) { killed=0;if(group_members(11,101,2,SIGKILL,2,allowed)!=4||killed)return 2; }
  return 0;
}
'''
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            file = root / 'group.c'
            file.write_text(stub + function + main)
            binary = root / 'group'
            result = subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(file), '-o', str(binary)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=2)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)



    def test_same_uid_quiescence_census_count_and_fd_paths(self):
        function = Path(__file__).with_name('quiescence.h').read_text()
        stub = r'''#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/types.h>
#define PATH_MAX 4096
#define PROC_PIDPATHINFO_MAXSIZE 4096
#define PROC_PIDVNODEPATHINFO 1
#define PROC_PIDLISTFDS 2
#define PROC_PIDFDVNODEPATHINFO 3
#define PROX_FDTYPE_VNODE 1
struct proc_bsdinfo { unsigned int pbi_uid,pbi_status; unsigned long long pbi_start_tvsec,pbi_start_tvusec; };
struct vnode_path { char vip_path[4096]; };
struct proc_vnodepathinfo { struct vnode_path pvi_cdir; };
struct proc_fdinfo { unsigned int proc_fdtype; int proc_fd; };
struct vnode_fdinfowithpath { struct vnode_path pvip; };
static int mode=0,foreign_read=0,stage=0,checks=0;
static unsigned int getuid(void) { return 501; }
static int getpid(void) { return 99; }
static char *realpath(const char *input,char *out) { strcpy(out,input);return out; }
static int identity(int pid,struct proc_bsdinfo *b) { b->pbi_uid=pid==12?999:501;b->pbi_status=1;b->pbi_start_tvsec=100;b->pbi_start_tvusec=1;return 1; }
static int same_birth(int pid,unsigned long long sec,unsigned long long usec) { (void)pid;(void)sec;(void)usec;checks++;if((mode==3&&stage==1)||(mode==4&&stage==2)||(mode==5&&stage==3)||(mode==6&&stage==4)||(mode==7&&stage==1)||(mode==8&&stage==4)||(mode==13&&checks>=3))return 3;if(mode==11&&stage==1)return 4;return 0; }
static int proc_listallpids(void *out,int bytes) { if(mode==1){errno=EPERM;return 0;}if(out){int p[]={10,11,12,99};if(bytes<16)return -1;memcpy(out,p,sizeof(p));}return 4; }
static int proc_pidpath(int pid,void *out,unsigned int size) { (void)size;if(pid==12)foreign_read=1;strcpy(out,"/fixture/node");return 14; }
static int proc_pidinfo(int pid,int flavor,unsigned long long arg,void *out,int size) {
 (void)arg;(void)size;if(pid==12)foreign_read=1;
 if(flavor==PROC_PIDVNODEPATHINFO){stage=1;if(mode==3||mode==9){errno=mode==3?ESRCH:EACCES;return -1;}strcpy(((struct proc_vnodepathinfo*)out)->pvi_cdir.vip_path,"/fixture/cwd");return sizeof(struct proc_vnodepathinfo);}
 if(!out){stage=2;if(mode==4){errno=ESRCH;return -1;}return sizeof(struct proc_fdinfo);}
 stage=3;
 if(mode==2||mode==5||mode==10){errno=mode==5?ESRCH:EPERM;return -1;}
 ((struct proc_fdinfo*)out)->proc_fdtype=PROX_FDTYPE_VNODE;((struct proc_fdinfo*)out)->proc_fd=3;return sizeof(struct proc_fdinfo);
}
static int proc_pidfdinfo(int pid,int fd,int flavor,void *out,int size) { (void)pid;(void)fd;(void)flavor;(void)size;stage=4;if(mode==6||mode==12){errno=mode==6?ESRCH:EBADF;return -1;}strcpy(((struct vnode_fdinfowithpath*)out)->pvip.vip_path,"/fixture/open");return sizeof(struct vnode_fdinfowithpath); }
'''
        main = r'''
int main(int argc,char **argv) { mode=argc>1?atoi(argv[1]):0;int rc=quiescence(10,"/fixture");if(foreign_read)return 9;return rc; }
'''
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'quiescent.c'
            source.write_text(stub + function + main)
            binary = root / 'quiescent'
            result = subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(source), '-o', str(binary)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=2)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('11\t/fixture/open', result.stdout)
            self.assertIn('COMPLETE', result.stdout)
            cases = {
                1: ('enumeration error', 4), 2: ('live fd read error', 4),
                3: ('exit before vnode read', 0), 4: ('exit at fd sizing', 0),
                5: ('exit during fd list', 0), 6: ('exit during fd vnode read', 0),
                7: ('exit after vnode read', 0), 8: ('exit after fd vnode read', 0),
                9: ('live vnode read error', 4), 10: ('live fd-list error', 4),
                11: ('birth mismatch', 4), 12: ('live closed-fd read error', 4),
                13: ('exit after matched paths before final fence', 0)}
            for mode, (name, expected) in cases.items():
                with self.subTest(case=name):
                    result = subprocess.run([str(binary), str(mode)], capture_output=True, text=True, timeout=2)
                    self.assertEqual(result.returncode, expected, result.stderr)
                    if not expected:
                        self.assertEqual(result.stdout, 'COMPLETE\n')
                    else:
                        self.assertNotIn('COMPLETE', result.stdout)


if __name__ == '__main__':
    unittest.main()
