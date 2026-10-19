#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <poll.h>
#include <errno.h>
#include <stdint.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif
#ifdef __APPLE__
#include <sys/un.h>
#include <sys/ucred.h>
#include <libproc.h>
#include <sys/proc.h>
#endif
static napi_value nil(napi_env env) { napi_value v; napi_get_null(env,&v); return v; }
static void number(napi_env e,napi_value o,const char *k,double n) { napi_value v; napi_create_double(e,n,&v); napi_set_named_property(e,o,k,v); }
static int argument(napi_env e,napi_callback_info info) {
  napi_value a[1]; size_t n=1; int32_t fd=-1; double raw;
  if(napi_get_cb_info(e,info,&n,a,NULL,NULL)!=napi_ok||n!=1||napi_get_value_double(e,a[0],&raw)!=napi_ok||napi_get_value_int32(e,a[0],&fd)!=napi_ok||raw!=(double)fd) return -1;
  return fd;
}
static void birth(pid_t pid,char *out,size_t len) {
  out[0]=0;
#ifdef __linux__
  char path[64],buf[4096]; snprintf(path,sizeof(path),"/proc/%d/stat",pid);
  FILE *f=fopen(path,"r"); if(!f) return;
  char *line=fgets(buf,sizeof(buf),f); fclose(f); if(!line) return;
  char *p=strrchr(buf,')'); if(!p||p[1]!=' ') return;
  p+=2; char *save=NULL,*v=strtok_r(p," ",&save); int field=3;
  while(v&&field<22) { v=strtok_r(NULL," ",&save); field++; }
  if(v&&strspn(v,"0123456789")==strlen(v)) snprintf(out,len,"linux:%s",v);
#elif defined(__APPLE__)
  struct proc_bsdinfo b;
  if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&b,sizeof(b))==(int)sizeof(b)) snprintf(out,len,"darwin:%llu:%llu",(unsigned long long)b.pbi_start_tvsec,(unsigned long long)b.pbi_start_tvusec);
#endif
}
static int credentials(int fd,uid_t *uid,pid_t *pid) {
#ifdef __linux__
  struct ucred c; socklen_t n=sizeof(c);
  if(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&c,&n)||n!=sizeof(c)||c.pid<=0||c.uid==(uid_t)-1) return 0;
  *uid=c.uid; *pid=c.pid; return 1;
#elif defined(__APPLE__)
  gid_t gid; socklen_t n=sizeof(*pid);
  if(getpeereid(fd,uid,&gid)||getsockopt(fd,SOL_LOCAL,LOCAL_PEERPID,pid,&n)||n!=sizeof(*pid)||*pid<=0) return 0;
  return 1;
#else
  return 0;
#endif
}
static napi_value inspect(napi_env e,napi_callback_info info) {
  int fd=argument(e,info); uid_t uid; pid_t pid;
  if(fd<0||!credentials(fd,&uid,&pid)) return nil(e);
  napi_value o,s; char b[96]; birth(pid,b,sizeof(b));
  napi_create_object(e,&o); number(e,o,"uid",uid); number(e,o,"pid",pid);
  napi_create_string_utf8(e,b,NAPI_AUTO_LENGTH,&s); napi_set_named_property(e,o,"birth",s); return o;
}
static napi_value pin(napi_env e,napi_callback_info info) {
  int fd=argument(e,info),pfd=-1; (void)fd;
#ifdef __linux__
#ifdef SO_PEERPIDFD
  socklen_t n=sizeof(pfd);
  if(getsockopt(fd,SOL_SOCKET,SO_PEERPIDFD,&pfd,&n)) pfd=-1;
#endif
#ifdef SYS_pidfd_open
  if(pfd<0) { uid_t uid; pid_t pid; if(credentials(fd,&uid,&pid)) pfd=(int)syscall(SYS_pidfd_open,pid,0); }
#endif
#endif
  napi_value v; napi_create_int32(e,pfd,&v); return v;
}
static napi_value alive(napi_env e,napi_callback_info info) {
  int fd=argument(e,info); struct pollfd p={.fd=fd,.events=POLLIN};
  int ready=fd<0?-1:poll(&p,1,0); napi_value v;
  napi_get_boolean(e,ready==0,&v); return v;
}
static napi_value process_birth(napi_env e,napi_callback_info info) {
  int pid=argument(e,info); char b[96]; if(pid<=0) return nil(e);
  birth((pid_t)pid,b,sizeof(b)); if(!b[0]) return nil(e);
  napi_value v; napi_create_string_utf8(e,b,NAPI_AUTO_LENGTH,&v); return v;
}
typedef struct { pid_t pid,ppid,pgid; uid_t uid; int zombie,wait_status; double started; char birth[96],boot[64]; } process_info;
static int process_read(pid_t pid,process_info *out) {
  memset(out,0,sizeof(*out)); out->pid=pid; out->wait_status=-1;
#ifdef __APPLE__
  struct proc_bsdinfo b; errno=0;
  int n=proc_pidinfo(pid,PROC_PIDTBSDINFO,1,&b,sizeof(b));
  if(n!=(int)sizeof(b)) return n==0&&errno==ESRCH?1:errno==EPERM||errno==EACCES?3:2;
  if(b.pbi_pid!=(uint32_t)pid||b.pbi_start_tvusec>=1000000) return 2;
  out->uid=b.pbi_uid; out->ppid=b.pbi_ppid; out->pgid=b.pbi_pgid; out->zombie=b.pbi_status==SZOMB;
  out->started=(double)b.pbi_start_tvsec*1000+(double)b.pbi_start_tvusec/1000;
  snprintf(out->birth,sizeof(out->birth),"darwin:%llu:%llu",(unsigned long long)b.pbi_start_tvsec,(unsigned long long)b.pbi_start_tvusec);
  return 0;
#elif defined(__linux__)
  char path[64],buf[8192]; snprintf(path,sizeof(path),"/proc/%d/stat",pid); errno=0;
  FILE *f=fopen(path,"r"); if(!f) return errno==ENOENT||errno==ESRCH?1:errno==EPERM||errno==EACCES?3:2;
  size_t n=fread(buf,1,sizeof(buf)-1,f); int bad=ferror(f)||!feof(f); fclose(f); if(bad||!n) return 2; buf[n]=0;
  char *p=strrchr(buf,')'); if(!p||p[1]!=' '||strtol(buf,NULL,10)!=pid) return 2;
  char *save=NULL,*v=strtok_r(p+2," \n",&save); unsigned long long ticks=0; int field=3;
  while(v) {
    if(field==3) { if(strlen(v)!=1) return 2; out->zombie=*v=='Z'; }
    if(field==4) out->ppid=(pid_t)strtol(v,NULL,10);
    if(field==5) out->pgid=(pid_t)strtol(v,NULL,10);
    if(field==22) { if(!*v||strspn(v,"0123456789")!=strlen(v)) return 2; errno=0; ticks=strtoull(v,NULL,10); if(errno) return 2; }
    if(field==52) out->wait_status=(int)strtol(v,NULL,10);
    v=strtok_r(NULL," \n",&save); field++;
  }
  if(field<=22) return 2;
  snprintf(path,sizeof(path),"/proc/%d",pid); struct stat st; if(stat(path,&st)) return errno==ENOENT?1:2; out->uid=st.st_uid;
  f=fopen("/proc/sys/kernel/random/boot_id","r"); if(!f) return 2;
  if(!fgets(out->boot,sizeof(out->boot),f)) { fclose(f); return 2; } fclose(f); out->boot[strcspn(out->boot,"\n")]=0;
  if(strlen(out->boot)!=36||strspn(out->boot,"0123456789abcdef-")!=36) return 2;
  f=fopen("/proc/stat","r"); if(!f) return 2; unsigned long long boot=0;
  while(fgets(buf,sizeof(buf),f)) if(sscanf(buf,"btime %llu",&boot)==1) break;
  fclose(f); long hz=sysconf(_SC_CLK_TCK); if(!boot||hz<=0) return 2;
  out->started=(double)boot*1000+(double)ticks*1000/(double)hz;
  snprintf(out->birth,sizeof(out->birth),"linux:%llu",ticks); return 0;
#else
  (void)pid; return 2;
#endif
}
static void text(napi_env e,napi_value o,const char *key,const char *value) { napi_value v; napi_create_string_utf8(e,value,NAPI_AUTO_LENGTH,&v); napi_set_named_property(e,o,key,v); }
static napi_value process_inspect(napi_env e,napi_callback_info info) {
  int pid=argument(e,info); process_info a,b; napi_value o; napi_create_object(e,&o);
  int result=pid<=0?2:process_read(pid,&a);
  if(result==0) {
    result=process_read(pid,&b);
    if(result==1||(result==0&&(strcmp(a.birth,b.birth)||strcmp(a.boot,b.boot)))) result=2;
  }
  text(e,o,"kind",result==0?"present":result==1?"gone":"unavailable");
  if(result!=0) { if(result!=1) text(e,o,"reason",result==3?"permission_denied":"native_observation_failed"); return o; }
  text(e,o,"birth",b.birth); text(e,o,"bootId",b.boot); text(e,o,"state",b.zombie?"zombie":"live");
  number(e,o,"pid",b.pid); number(e,o,"uid",b.uid); number(e,o,"ppid",b.ppid); number(e,o,"pgid",b.pgid); number(e,o,"startedAtMs",b.started); number(e,o,"waitStatus",b.wait_status); return o;
}
static napi_value init(napi_env e,napi_value o) {
  napi_property_descriptor d[]={{"inspect",0,inspect,0,0,0,napi_default,0},{"pin",0,pin,0,0,0,napi_default,0},{"alive",0,alive,0,0,0,napi_default,0},{"processBirth",0,process_birth,0,0,0,napi_default,0}};
  napi_define_properties(e,o,4,d); napi_property_descriptor p={"inspectProcess",0,process_inspect,0,0,0,napi_default,0}; napi_define_properties(e,o,1,&p); return o;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
