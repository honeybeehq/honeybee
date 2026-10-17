#define _GNU_SOURCE
#include <dlfcn.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

static int seen;
static int selected(int fd,const char *op) {
  const char *root=getenv("HB_FILE_ROOT"),*operation=getenv("HB_FILE_OP"),*nth=getenv("HB_FILE_N");
  if(!root || !operation || strcmp(operation,op) || !nth) return 0;
  char path[64],target[8192];snprintf(path,sizeof(path),"/proc/self/fd/%d",fd);
  ssize_t length=readlink(path,target,sizeof(target)-1);
  if(length<0) return 0;
  target[length]=0;
  size_t size=strlen(root);
  if(strncmp(target,root,size) || (target[size] && target[size]!='/')) return 0;
  return ++seen==atoi(nth);
}
int fsync(int fd) {
  int (*real_fsync)(int)=dlsym(RTLD_NEXT,"fsync");
  int hit=selected(fd,"fsync");
  const char *mode=getenv("HB_FILE_MODE");
  if(hit && mode && !strcmp(mode,"before")) _exit(91);
  if(hit && mode && !strcmp(mode,"error")) { errno=EIO; return -1; }
  int result=real_fsync(fd);
  if(hit && mode && !strcmp(mode,"after")) _exit(91);
  return result;
}
int unlinkat(int dir,const char *name,int flags) {
  int (*real_unlinkat)(int,const char *,int)=dlsym(RTLD_NEXT,"unlinkat");
  if(selected(dir,"unlinkat")) { errno=EIO; return -1; }
  return real_unlinkat(dir,name,flags);
}
int close(int fd) {
  int (*real_close)(int)=dlsym(RTLD_NEXT,"close");
  int hit=selected(fd,"close"),result=real_close(fd);
  if(hit) { errno=EIO; return -1; }
  return result;
}
