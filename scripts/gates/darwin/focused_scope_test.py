import json
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
            result = subprocess.run([str(binary)], input="1\n7 42\n2\n77\n88\n1\n11 10 100 1\n", capture_output=True, text=True, timeout=2)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)



    def test_sorted_inode_lookup_preserves_exact_unsigned_keys_and_bounds_comparisons(self):
        header=Path(__file__).with_name('quiescence.h').read_text()
        start=header.index('struct root_inode {')
        code=header[start:header.index('static int gate_launch_pids',start)]
        code=code.replace('static int root_inode_compare(const void *left, const void *right) {','static int root_inode_compare(const void *left, const void *right) { comparisons++;')
        source = '#include <stdlib.h>\n#include <string.h>\nstatic int comparisons;\n' + code + r"""
int main(void) {
  struct root_inode input[]={{~0ULL,42},{7,~0ULL},{7,42},{8,42},{0,0},{7,42},{7,1}};
  int count=sizeof(input)/sizeof(input[0]);
  memcpy(root_inodes,input,sizeof(input));
  qsort(root_inodes,(size_t)count,sizeof(root_inodes[0]),root_inode_compare);
  for(int i=0;i<count;i++) if(!root_inode_match(input[i].dev,input[i].ino,count)) return 1;
  if(root_inode_match(9,42,count)||root_inode_match(7,2,count)||root_inode_match(7,42,0)) return 2;
  for(int i=0;i<1000000;i++){root_inodes[i].dev=17;root_inodes[i].ino=1000000-i;}
  qsort(root_inodes,1000000,sizeof(root_inodes[0]),root_inode_compare);
  comparisons=0;
  if(!root_inode_match(17,1,1000000)||!root_inode_match(17,500000,1000000)||!root_inode_match(17,1000000,1000000)||root_inode_match(17,0,1000000)||root_inode_match(17,1000001,1000000)||root_inode_match(18,500000,1000000))return 3;
  return comparisons<=126?0:4;
}
"""
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            (root/'lookup.c').write_text(source)
            result=subprocess.run(['/usr/bin/cc','-std=c11','-Wall','-Wextra','-Werror',str(root/'lookup.c'),'-o',str(root/'lookup')],capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            result=subprocess.run([str(root/'lookup')],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)

    def test_same_uid_quiescence_census_count_and_fd_paths(self):
        scope = Path(__file__).with_name('scope.c').read_text()
        start = scope.index('static int quiescence_sandbox_denied(', scope.index('static sandbox_check_function sandbox_checker'))
        query_function = scope[start:scope.index('static int node_observation(', start)]
        csops_function = scope[scope.index('#define CS_OPS_STATUS'):scope.index('static int quiescence_sandbox_denied(')]
        function = Path(__file__).with_name('quiescence.h').read_text().replace('counts.skipped_uid_changed++;', 'counts.skipped_uid_changed++; observed_uid_skip++;')
        stub = r'''#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/types.h>
#define PATH_MAX 4096
#define PROC_PIDPATHINFO_MAXSIZE 4096
#define PROC_UID_ONLY 4
#define PROC_PIDREGIONPATHINFO 8
#define PROC_REGION_SUBMAP 1
#define SM_COW 1
#define SM_PRIVATE 2
#define SM_EMPTY 3
#define SM_SHARED 4
#define SM_TRUESHARED 5
#define SM_PRIVATE_ALIASED 6
#define SM_SHARED_ALIASED 7
#define SM_LARGE_PAGE 8
#define RTLD_DEFAULT ((void*)0)
#define CS_OPS_STATUS 0U
#define CS_PLATFORM_BINARY 0x04000000U
#define PROC_PIDVNODEPATHINFO 1
#define PROC_PIDLISTFDS 2
#define PROC_PIDFDVNODEPATHINFO 3
#define PROX_FDTYPE_VNODE 1
struct proc_regionwithpathinfo { struct { unsigned long long pri_address,pri_size; unsigned int pri_flags,pri_share_mode; } prp_prinfo; struct { struct { struct { unsigned int vst_dev; unsigned long long vst_ino; } vi_stat; } vip_vi; } prp_vip; };
struct proc_bsdinfo { unsigned int pbi_uid,pbi_status,pbi_pgid,pbi_ppid; unsigned long long pbi_start_tvsec,pbi_start_tvusec; };
struct vnode_path { char vip_path[4096]; };
struct proc_vnodepathinfo { struct vnode_path pvi_cdir; };
struct proc_fdinfo { unsigned int proc_fdtype; int proc_fd; };
struct vnode_fdinfowithpath { struct vnode_path pvip; };
static int mode=0,foreign_read=0,stage=0,checks=0,observed_uid_skip=0,query_index=0,region_calls=0,region_checks=0;
static unsigned int getuid(void) { return 501; }
static int getpid(void) { return 99; }
static char *realpath(const char *input,char *out) { if(mode==92&&!strcmp(input,"/System/Library/Agent")){strcpy(out,"/Users/other/Agent");return out;}if(!strcmp(input,"/fixture/t/nonexistent")){errno=ENOENT;return NULL;}strcpy(out,input);return out; }
static int identity(int pid,struct proc_bsdinfo *b) { if(pid==12)foreign_read=1;if(mode==17){errno=EPERM;return 0;}b->pbi_ppid=10;b->pbi_uid=pid==12||mode==16?999:501;b->pbi_status=1;b->pbi_pgid=mode==30?88:11;b->pbi_start_tvsec=pid==10?150:mode==19?250:mode==20||mode==47?160:mode==28?199:100;b->pbi_start_tvusec=1;return 1; }
static int same_birth(int pid,unsigned long long sec,unsigned long long usec) { (void)pid;(void)sec;(void)usec;checks++;errno=0;if(mode==134&&region_calls==3)return 4;if(mode==136&&region_calls==2&&++region_checks==2)return 4;if((mode==3&&stage==1)||(mode==4&&stage==2)||(mode==5&&stage==3)||(mode==6&&stage==4)||(mode==7&&stage==1)||(mode==8&&stage==4)||(mode==13&&checks>=3))return 3;if(mode==11&&stage==1)return 4;return 0; }
static int proc_listpids(unsigned int type,unsigned int uid,void *out,int bytes) { if(type!=PROC_UID_ONLY||uid!=501){foreign_read=1;return 0;}if(mode==1){errno=EPERM;return 0;}if(out){int p[]={10,11,99};if(bytes<12)return -1;memcpy(out,p,sizeof(p));}return 12; }
struct stat { unsigned int st_dev; unsigned long long st_ino; };
static int stat(const char *path,struct stat *out) { (void)path;out->st_dev=7;out->st_ino=43;return 0; }
static int csops(int pid,unsigned int op,void *out,size_t size) { (void)pid;if(op!=CS_OPS_STATUS||size!=sizeof(unsigned int))return -1;if(mode==82){errno=EPERM;return -1;}*(unsigned int*)out=mode==81?0:CS_PLATFORM_BINARY;return 0; }
static void *dlsym(void *handle,const char *name) { (void)handle;if(strcmp(name,"csops"))foreign_read=1;return mode==99?NULL:(void*)csops; }
static int getsid(int pid) { if(pid==10)return 10;return mode==21?10:mode==26?66:mode==29?77:11; }
static int proc_pidpath(int pid,void *out,unsigned int size) { (void)size;if(pid==12)foreign_read=1;if(mode>=103){strcpy(out,"/System/Library/Agent");return 21;}if(mode>=80&&mode<=99){const char *paths[]={"/System/Library/Agent","/System/Library/Agent","/System/Library/Agent","/bin/sh","/sbin/tool","/usr/bin/tool","/usr/local/tool","/Applications/Agent","/Users/other/Agent","/System/LibraryX/Agent","/usr/libexecfoo/Agent","/System/ApplicationsX/Agent","/System/Library/Agent","/System/Library/Agent","/System/Applications/Agent","/usr/libexec/Agent","/usr/sbin/Agent","/System/Library/Agent","/System/Library/Agent","/System/Library/Agent"};if(mode==98){errno=ENOENT;return 0;}strcpy(out,paths[mode-80]);return (int)strlen(out);}if((mode>=18&&mode<=30)||mode==50||mode==100||mode==101||mode==102){errno=mode==27||mode==50?EPERM:ENOENT;return 0;}strcpy(out,mode>=31&&mode!=49?"/outside/node":"/fixture/node");return 14; }
static int proc_pidinfo(int pid,int flavor,unsigned long long arg,void *out,int size) {
 (void)size;if(pid==12)foreign_read=1;
 if(flavor==PROC_PIDREGIONPATHINFO){
 region_calls++;
 if(mode>=130){
 if(arg==0){struct proc_regionwithpathinfo *r=out;r->prp_prinfo.pri_address=4096;r->prp_prinfo.pri_size=4096;r->prp_vip.vip_vi.vi_stat.vst_dev=7;r->prp_vip.vip_vi.vi_stat.vst_ino=43;return sizeof(*r);}
 if(arg==8192){errno=EINVAL;return 0;}
 if(arg!=8193){foreign_read=1;return 0;}
 if(mode==130){struct proc_regionwithpathinfo *r=out;r->prp_prinfo.pri_address=12288;r->prp_prinfo.pri_size=4096;return sizeof(*r);}
 if(mode==131){errno=EPERM;return 0;}
 if(mode==132){errno=0;return 1;}
 if(mode==133){errno=0;return 0;}
 errno=EINVAL;return 0;
 }
 if(mode==124){errno=0;return 1;}
 if(mode>=120){
 struct proc_regionwithpathinfo *r=out;r->prp_vip.vip_vi.vi_stat.vst_dev=7;r->prp_vip.vip_vi.vi_stat.vst_ino=43;
 if(arg==0){r->prp_prinfo.pri_address=4096;r->prp_prinfo.pri_size=4096;return sizeof(*r);}
 if(arg==8192){r->prp_prinfo.pri_address=mode==122?4096:mode==123?~0ULL:8192;r->prp_prinfo.pri_size=0;r->prp_prinfo.pri_share_mode=mode==120?SM_COW:SM_PRIVATE;r->prp_vip.vip_vi.vi_stat.vst_ino=42;return sizeof(*r);}
 if(mode==120&&arg==8193){r->prp_prinfo.pri_address=12288;r->prp_prinfo.pri_size=4096;return sizeof(*r);}
 errno=EINVAL;return 0;
 }
 if(mode>=110){
 struct proc_regionwithpathinfo *r=out;
 r->prp_vip.vip_vi.vi_stat.vst_dev=7;r->prp_vip.vip_vi.vi_stat.vst_ino=43;
 if(arg==0){r->prp_prinfo.pri_address=mode>=115?~0ULL-4095:4096;r->prp_prinfo.pri_size=mode==114?0:mode==115?8192:mode>=116?4095:4096;return sizeof(*r);}
 if(mode==110&&arg==8192){r->prp_prinfo.pri_address=4096;r->prp_prinfo.pri_size=8192;r->prp_prinfo.pri_flags=PROC_REGION_SUBMAP;r->prp_vip.vip_vi.vi_stat.vst_ino=0;return sizeof(*r);}
 if(mode==112&&arg==8192){r->prp_prinfo.pri_address=8192;r->prp_prinfo.pri_size=128;r->prp_vip.vip_vi.vi_stat.vst_ino=0;return sizeof(*r);}
 if(mode==113&&arg==8192){r->prp_prinfo.pri_address=4096;r->prp_prinfo.pri_size=4096;r->prp_prinfo.pri_flags=PROC_REGION_SUBMAP;return sizeof(*r);}
 if(mode==117&&arg==~0ULL){r->prp_prinfo.pri_address=~0ULL-4095;r->prp_prinfo.pri_size=4095;return sizeof(*r);}
 errno=EINVAL;return 0;
 }
 int first=arg==0;
 if((mode==24||mode==25||(mode>=80&&mode<=99&&mode!=97)||(mode>=100&&mode!=107))&&first){struct proc_regionwithpathinfo *r=out;r->prp_prinfo.pri_address=4096;r->prp_prinfo.pri_size=4096;r->prp_vip.vip_vi.vi_stat.vst_dev=7;r->prp_vip.vip_vi.vi_stat.vst_ino=mode==24||mode==93?42:mode==108||mode==109?44:43;return sizeof(*r);}
 if((mode==102||mode==105)&&!first&&arg==8192){struct proc_regionwithpathinfo *r=out;r->prp_prinfo.pri_address=8192;r->prp_prinfo.pri_size=4096;r->prp_vip.vip_vi.vi_stat.vst_dev=7;r->prp_vip.vip_vi.vi_stat.vst_ino=42;return sizeof(*r);}
 if((mode==100||mode==101||mode==103||mode==104||mode==108)&&!first){errno=mode==100||mode==103||mode==108?EPERM:0;return mode==100||mode==103||mode==108?0:1;}
 errno=(mode==18||mode==97||mode==107)?EPERM:EINVAL;return 0;}

 if(flavor==PROC_PIDVNODEPATHINFO){stage=1;if(mode==3||mode==9){errno=mode==3?ESRCH:EACCES;return -1;}strcpy(((struct proc_vnodepathinfo*)out)->pvi_cdir.vip_path,mode>=18&&mode!=22&&mode!=48?"/outside":"/fixture/cwd");return sizeof(struct proc_vnodepathinfo);}
 if(!out){stage=2;if(mode==4){errno=ESRCH;return -1;}return (mode==12||mode==14||mode==15?2:1)*sizeof(struct proc_fdinfo);}
 stage=3;
 if(mode==2||mode==5||mode==10){errno=mode==5?ESRCH:EPERM;return -1;}
 ((struct proc_fdinfo*)out)->proc_fdtype=PROX_FDTYPE_VNODE;((struct proc_fdinfo*)out)->proc_fd=3;if(mode==12||mode==14||mode==15){((struct proc_fdinfo*)out)[1].proc_fdtype=PROX_FDTYPE_VNODE;((struct proc_fdinfo*)out)[1].proc_fd=4;return 2*sizeof(struct proc_fdinfo);}return sizeof(struct proc_fdinfo);
}
static int proc_pidfdinfo(int pid,int fd,int flavor,void *out,int size) { (void)pid;(void)fd;(void)flavor;(void)size;stage=4;if((mode>=31&&mode<100)||mode>=103){errno=EPERM;return -1;}if(mode==6||(fd==3&&(mode==12||mode==14||mode==15))){errno=mode==6?ESRCH:mode==12?EBADF:mode==14?ENOENT:EPERM;return -1;}strcpy(((struct vnode_fdinfowithpath*)out)->pvip.vip_path,mode>=18&&mode!=23?"/outside":"/fixture/open");return sizeof(struct vnode_fdinfowithpath); }
typedef int (*sandbox_check_function)(pid_t,const char*,int,...);
static int fake_sandbox_check(pid_t pid,const char *op,int filter,...) { (void)pid;(void)filter;if(!op)return mode==41||mode>=80?0:1;if(strcmp(op,"file-read-data")&&strcmp(op,"file-write-data")&&strcmp(op,"file-write-create")&&strcmp(op,"file-write-unlink")){errno=EINVAL;return -1;}int index=query_index++;if(mode==40){errno=EPERM;return 1;}if(mode==73&&!strcmp(op,"file-write-create")){errno=EINVAL;return -1;}if(mode>=60&&mode<=73){int writes[]={1,3,5,7,8,9,10,11,12,13,14,15};if(index<8&&index%2==0)return 0;if(mode>=61&&mode<=72&&index==writes[mode-61])return 0;}if(mode>=32&&mode<=39&&index==mode-32)return 0;return 1; }
static sandbox_check_function sandbox_checker(void) { return mode==44?NULL:fake_sandbox_check; }
'''
        main = r'''
int main(int argc,char **argv) { mode=argc>1?atoi(argv[1]):0;int rc=quiescence(10,"/fixture",200000000,(char*[]){"/fixture","/fixture/sealed-probe","/fixture/src/package.json","/fixture/t/nonexistent"});if(foreign_read)return 9;if(mode==16&&observed_uid_skip!=1)return 10;if(mode==134&&region_calls!=3)return 11;if(mode==136&&region_calls!=2)return 12;return rc; }
'''
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'quiescent.c'
            source.write_text(stub + csops_function + query_function + function + main)
            binary = root / 'quiescent'
            result = subprocess.run(['/usr/bin/cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(source), '-o', str(binary)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(binary)], input="1\n7 42\n2\n77\n88\n1\n11 10 100 1\n", capture_output=True, text=True, timeout=2)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('OWN\t11\t10\t100\t1\tfd\topen', result.stdout)
            self.assertIn('COMPLETE', result.stdout)
            foreign = subprocess.run([str(binary)], input="1\n7 42\n0\n0\n", capture_output=True, text=True, timeout=2)
            self.assertEqual(foreign.returncode, 0, foreign.stderr)
            self.assertEqual(foreign.stdout, 'FOREIGN\tcwd\t1\nFOREIGN\texe\t1\nFOREIGN\tfd\t1\nCOMPLETE\n')
            self.assertNotIn('/fixture', foreign.stdout + foreign.stderr)
            self.assertNotIn('OWN', foreign.stdout)
            for mode, inode in ((24,42),(80,43)):
                unsorted = '3\n7 ' + str(inode) + '\n7 1\n7 99\n2\n77\n88\n1\n11 10 100 1\n'
                result = subprocess.run([str(binary),str(mode)],input=unsorted,capture_output=True,text=True,timeout=2)
                self.assertEqual(result.returncode,4,result.stderr)
                self.assertEqual(json.loads(result.stderr)['counts']['inodeMatch'],1)
            cases = {
                1: ('enumeration error', 4), 2: ('live fd read error', 4),
                3: ('exit before vnode read', 0), 4: ('exit at fd sizing', 0),
                5: ('exit during fd list', 0), 6: ('exit during fd vnode read', 0),
                7: ('exit after vnode read', 0), 8: ('exit after fd vnode read', 0),
                9: ('live vnode read error', 4), 10: ('live fd-list error', 4),
                11: ('birth mismatch', 4), 12: ('live EBADF skips fd and continues', 0),
                13: ('exit after matched paths before final fence', 0),
                14: ('live ENOENT skips fd and continues', 0), 15: ('live EPERM fails', 4), 16: ('uid changed after enumeration skips', 0), 17: ('same uid identity EPERM fails', 4), 18: ('pre-root unlinked unavailable region allowed', 0), 19: ('post-root unlinked fails', 4), 20: ('gate descendant birth fails', 4), 21: ('gate session or pgid fails', 4), 22: ('unlinked dirty cwd fails', 4), 23: ('unlinked dirty fd fails', 4), 24: ('region inode in manifest fails', 4), 25: ('region inode outside manifest allowed', 0), 26: ('root-owned session leader informational only', 0), 27: ('pidpath EPERM still fails', 4), 28: ('one second margin fails', 4), 29: ('sid in retained gate launch set fails', 4), 30: ('pgid in retained gate launch set fails', 4), 31: ('fd EPERM all eight denied accepts', 0), **{mode: ('read-only alternative or data-write refusal',0 if mode%2==0 else 4) for mode in range(32,40)}, 40: ('sandbox query error fails',4), 41: ('not sandboxed fails',4), 44: ('SPI unavailable fails',4), 47: ('fd EPERM gate process fails',4), 48: ('fd EPERM dirty cwd fails',4), 49: ('fd EPERM dirty exe fails',4), 50: ('exe EPERM fails before fd exception',4),60:('read allowed twelve writes denied accepts',0),**{mode:('each of twelve write allows fails',4) for mode in range(61,73)},73:('unknown write-create op errors',4),**{mode:('platform binary prefix and status proof',0 if mode in (80,94,95,96) else 4) for mode in range(80,100)},100:('region mid-walk error refuses ENOENT',4),101:('region short read refuses ENOENT',4),102:('later inventory inode refuses ENOENT',4),103:('main image then error refuses platform',4),104:('main image then short read refuses platform',4),105:('main image then inventory inode refuses platform',4),106:('complete platform walk accepts main image',0),107:('first unavailable refuses platform',4),108:('partial before main-image proof',4),109:('complete without main-image proof',4),110:('containing submap sequence completes',0),111:('normal last-region EINVAL completes',0),112:('synthetic footprint then EINVAL completes',0),113:('repeated last region remains partial',4),114:('zero cannot supply main-image proof',4),115:('region end overflow fails',4),116:('highest end cannot confirm without increment overflow',4),117:('request increment overflow fails',4),120:('mid-walk zero skipped without inode comparison',0),121:('end zero skipped then EINVAL',0),122:('zero start below request remains partial',4),123:('zero start increment overflow fails',4),124:('first successful short read remains partial',4),130:('second end probe returns region and refuses',4),131:('second end probe EPERM refuses',4),132:('second end probe short read refuses',4),133:('second end probe no errno refuses',4),134:('birth changes after second end probe refuses',4),135:('two adjacent EINVAL probes complete',0),136:('birth changes before second end probe refuses',4)}
            for mode, (name, expected) in cases.items():
                with self.subTest(case=name):
                    result = subprocess.run([str(binary), str(mode)], input="1\n7 42\n2\n77\n88\n1\n11 10 100 1\n", capture_output=True, text=True, timeout=2)
                    self.assertEqual(result.returncode, expected, result.stderr)
                    if mode in (12, 14):
                        self.assertIn('OWN\t11\t10\t100\t1\tfd\topen\n', result.stdout)
                        self.assertTrue(result.stdout.endswith('COMPLETE\n'))
                    elif not expected:
                        self.assertEqual(result.stdout, 'COMPLETE\n')
                        reason = json.loads(result.stderr)
                        if mode==31:
                            self.assertEqual(reason['counts']['fdUnobservableSandboxDenied'],1)
                            self.assertEqual(reason['counts']['fdDeniedQueries'],8)
                            self.assertEqual(reason['fdFailedQueryResults'],[-2]*16)
                            self.assertEqual(sum(reason['fdAllowedByQuery'].values()),0)
                        if mode in (80,94,95,96,106,110,111,112,120,121,135):
                            self.assertEqual(reason['counts']['fdUnobservablePlatformBinary'],1)
                            self.assertEqual(reason['counts']['fdUnobservableSandboxDenied'],0)
                            self.assertEqual(reason['counts']['fdUnobservableWriteDenied'],0)
                        if mode in (120,121):
                            self.assertEqual(reason['counts']['regionZeroSize'],1)
                            self.assertEqual(reason['counts']['regionCompared'],2 if mode==120 else 1)
                            self.assertEqual(reason['regionZeroSizeDetail'], {'returnLength':'exact','shareMode':'SM_COW' if mode==120 else 'SM_PRIVATE','regionKind':'mapping','lastBeforeEINVAL':'no' if mode==120 else 'yes'})
                        if mode==60 or mode in (32,34,36,38):
                            self.assertEqual(reason['counts']['fdUnobservableWriteDenied'],1)
                            self.assertEqual(reason['counts']['fdUnobservableSandboxDenied'],0)
                            self.assertEqual(sum(row['allowed'] for row in reason['fdWriteDeniedReadResults'].values()),4 if mode==60 else 1)
                            self.assertEqual(reason['fdFailedQueryResults'],[-2]*16)
                        if mode==26:
                            self.assertEqual(reason['counts']['exeUnlinkedPreRoot'], 1)
                            self.assertGreaterEqual(reason['counts']['sessionLeaderNotUidListed'], 1)
                        if mode in (18,25):
                            self.assertEqual(reason['counts']['exeUnlinkedPreRoot'], 1)
                            self.assertEqual(reason['counts']['regionUnavailable'], int(mode==18))
                            self.assertEqual(reason['counts']['regionCompared'], int(mode==25))
                    else:
                        self.assertNotIn('COMPLETE', result.stdout)
                        reason = json.loads(result.stderr)
                        self.assertEqual(reason['type'], 'QuiescenceFailure')
                        self.assertEqual(reason['counts']['failed'], 1)
                        if mode in (100,101,103,104,108):
                            self.assertEqual(reason['counts']['regionPartial'],1)
                            self.assertEqual(reason['regionPartialDetail'], {'errno':'EPERM' if mode in (100,103,108) else 'NONE','regionsRead':1,'mainImageSeen':int(mode in (103,104)), 'termination':'read-error' if mode in (100,103,108) else 'short-read', 'regionKind':'unobserved','lastBeforeEINVAL':'unknown'})
                        if mode in (113,115,117):
                            self.assertEqual(reason['counts']['regionPartial'],1)
                            self.assertEqual(reason['regionPartialDetail'], {'errno':'NONE','regionsRead':2 if mode in (113,117) else 1,'mainImageSeen':1,'termination':{113:'end-not-past-request',115:'overflow',117:'overflow'}[mode],'regionKind':'submap' if mode==113 else 'mapping','lastBeforeEINVAL':'unknown'})
                            self.assertEqual(reason['platformFailures']['regionPartial'],1)
                        if mode in (103,104,108):
                            self.assertEqual(reason['platformFailures']['regionPartial'],1)
                        if mode in (109,114):
                            self.assertEqual(reason['platformFailures']['mainImageMissing'],1)
                        if 80 <= mode <= 124 and mode not in (100,101,102):
                            self.assertEqual(sum(reason['platformFailures'].values()),1)
                        if mode in (130,131,132,133):
                            self.assertEqual(reason['regionPartialDetail']['termination'],'end-confirmation')
                            self.assertEqual(reason['regionPartialDetail']['errno'],'EPERM' if mode==131 else 'NONE')
                            self.assertEqual(reason['platformFailures']['regionPartial'],1)
                        if mode in (134,136):
                            self.assertEqual(reason['platformFailures']['regionRejected'],1)
                        if mode==116:
                            self.assertEqual(reason['regionPartialDetail']['termination'],'overflow')
                        if mode in (122,123):
                            self.assertEqual(reason['counts']['regionZeroSize'],0)
                            self.assertEqual(reason['regionPartialDetail']['termination'],'end-not-past-request' if mode==122 else 'overflow')
                            self.assertEqual(reason['regionZeroSizeDetail'],{'returnLength':'exact','shareMode':'SM_PRIVATE','regionKind':'mapping','lastBeforeEINVAL':'unknown'})
                        if mode==124:
                            self.assertEqual(reason['counts']['regionPartial'],1)
                            self.assertEqual(reason['counts']['regionUnavailable'],0)
                            self.assertEqual(reason['regionZeroSizeDetail'],{'returnLength':'unobserved','shareMode':'UNOBSERVED','regionKind':'unobserved','lastBeforeEINVAL':'not-applicable'})
                        if mode==107:
                            self.assertEqual(reason['counts']['regionUnavailable'],1)
                        self.assertNotIn('/fixture', result.stderr)
                        self.assertNotIn('pid', reason)
                        if 32 <= mode <= 39:
                            self.assertEqual(reason['counts']['fdSandboxFailed'],1)
                            self.assertEqual(reason['counts']['fdAllowedQueries'],1)
                            slots = ('root:read','root:write','probe:read','probe:write','src:read','src:write','absent:read','absent:write','root:create','root:unlink','probe:create','probe:unlink','src:create','src:unlink','absent:create','absent:unlink')
                            self.assertEqual(reason['fdAllowedByQuery'], {slot:int(index==mode-32) for index,slot in enumerate(slots)})
                            self.assertEqual(reason['fdFailedQueryResults'], [int(index!=mode-32) for index in range(16)])
                        if mode in (40,44):
                            self.assertEqual(reason['counts']['fdQueryErrors'],1)
                            if mode==40:self.assertEqual(reason['fdFailedQueryResults'],[-1]+[-2]*15)
                        if mode==41:
                            self.assertEqual(reason['counts']['fdNotSandboxed'],1)
                        if mode==47:
                            self.assertEqual(reason['counts']['fdNonGateFailed'],1)
                        if mode in (48,49):
                            self.assertEqual(reason['counts']['fdCleanFailed'],1)
                        if 61<=mode<=72:
                            self.assertEqual(reason['counts']['fdSandboxFailed'],1)
                            writes=(1,3,5,7,8,9,10,11,12,13,14,15)
                            expected=[0 if index in (0,2,4,6,writes[mode-61]) else 1 for index in range(16)]
                            self.assertEqual(reason['fdFailedQueryResults'],expected)
                        if mode==73:
                            self.assertEqual(reason['fdFailedQueryResults'],[0,1]*4+[-1]+[-2]*7)
                            self.assertEqual(reason['counts']['fdQueryErrors'],1)
                        if mode==99:self.assertEqual(reason['counts']['csopsUnavailable'],1)
                        if mode==81:self.assertEqual(reason['counts']['notPlatform'],1)
                        if mode==82:self.assertEqual(reason['counts']['csopsError'],1)
                        if mode in range(83,93):self.assertEqual(reason['counts']['pathDisallowed'],1)
                        if mode==93:self.assertEqual(reason['counts']['inodeMatch'],1)
                        if mode==97:self.assertEqual(reason['counts']['platformInodeUnobserved'],1)
                        if mode == 17:
                            self.assertEqual((reason['call'], reason['errno']), ('birth', 'EPERM'))
                        if mode == 15:
                            self.assertEqual((reason['call'], reason['errno'], reason['sameBirth']), ('fdinfo', 'EPERM', 0))
                        if mode == 11:
                            self.assertEqual((reason['call'], reason['sameBirth']), ('birth', 4))


if __name__ == '__main__':
    unittest.main()
