#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <poll.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif
#ifdef __APPLE__
#include <sys/un.h>
#include <sys/ucred.h>
#include <libproc.h>
#endif
static napi_value nil(napi_env env) { napi_value v; napi_get_null(env,&v); return v; }
static void number(napi_env e,napi_value o,const char *k,double n) { napi_value v; napi_create_double(e,n,&v); napi_set_named_property(e,o,k,v); }
static int argument(napi_env e,napi_callback_info info) {
  napi_value a[1]; size_t n=1; int32_t fd=-1;
  if(napi_get_cb_info(e,info,&n,a,NULL,NULL)!=napi_ok||n!=1||napi_get_value_int32(e,a[0],&fd)!=napi_ok) return -1;
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
static napi_value init(napi_env e,napi_value o) {
  napi_property_descriptor d[]={{"inspect",0,inspect,0,0,0,napi_default,0},{"pin",0,pin,0,0,0,napi_default,0},{"alive",0,alive,0,0,0,napi_default,0}};
  napi_define_properties(e,o,3,d); return o;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
