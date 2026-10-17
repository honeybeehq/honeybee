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


if __name__ == '__main__':
    unittest.main()
