#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <node_api.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <dirent.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define LIMIT (8u * 1024u * 1024u)
static _Atomic unsigned long sequence;
static napi_value failure(napi_env env, const char *code) {
  napi_throw_error(env, code, strerror(errno));
  return NULL;
}
static int opaque(const char *s, size_t length, int dash) {
  if (strlen(s) != length) return 0;
  for (size_t i=0; i<length; i++) if (!((s[i]>='a'&&s[i]<='f')||(s[i]>='0'&&s[i]<='9')||(dash&&s[i]=='-'))) return 0;
  return 1;
}
static int directory(int parent, const char *name, int create) {
  if (create && mkdirat(parent,name,0700)<0 && errno!=EEXIST) return -1;
  int fd=openat(parent,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if (fd<0) return -1;
  struct stat st,parent_st;
  if (fstat(fd,&st)<0 || fstat(parent,&parent_st)<0 || !S_ISDIR(st.st_mode) || st.st_uid!=geteuid() || (st.st_mode&0777)!=0700 || st.st_dev!=parent_st.st_dev) {
    close(fd); errno=EPERM; return -1;
  }
  if (create && fsync(parent)<0) {
    int error=errno; close(fd); errno=error; return -1;
  }
  return fd;
}
static int root_directory(const char *root) {
  if (!root || root[0]!='/' || !root[1] || strlen(root)>4096) { errno=EINVAL; return -1; }
  char *copy=strdup(root), *save=NULL;
  if (!copy) return -1;
  int fd=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
  for (char *part=strtok_r(copy,"/",&save); part && fd>=0; part=strtok_r(NULL,"/",&save)) {
    if (!strcmp(part,".") || !strcmp(part,"..")) { close(fd); fd=-1; errno=EINVAL; break; }
    int next=openat(fd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    int error=next<0?errno:0;
    if(close(fd)<0 && !error) error=errno;
    if(error && next>=0) { close(next); next=-1; }
    fd=next; errno=error;
  }
  free(copy);
  if(fd>=0) {
    struct stat st;
    if(fstat(fd,&st)<0 || !S_ISDIR(st.st_mode) || st.st_uid!=geteuid() || (st.st_mode&0022)) {
      close(fd); errno=EPERM; return -1;
    }
  }
  return fd;
}
static int bee_directory(const char *root,const char *bee,int create) {
  int base=root_directory(root);
  if (base<0) return -1;
  int files=directory(base,"delivery-content",create), error=files<0?errno:0;
  if(close(base)<0 && !error) error=errno;
  if(error && files>=0) { close(files); files=-1; }
  errno=error;
  if (files<0) return -1;
  int result=directory(files,bee,create); error=result<0?errno:0;
  if(close(files)<0 && !error) error=errno;
  if(error && result>=0) { close(result); result=-1; }
  errno=error; return result;
}
static int equal_file(int dir,const char *name,const unsigned char *bytes,size_t length) {
  int fd=openat(dir,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
  if(fd<0) return -1;
  struct stat st;
  if(fstat(fd,&st)<0 || !S_ISREG(st.st_mode) || st.st_uid!=geteuid() || (st.st_mode&0777)!=0600 || st.st_size!=(off_t)length) {
    close(fd); errno=EEXIST; return -1;
  }
  unsigned char chunk[8192]; size_t offset=0;
  while(offset<length) {
    ssize_t n=read(fd,chunk,sizeof(chunk)<length-offset?sizeof(chunk):length-offset);
    if(n<0 && errno==EINTR) continue;
    if(n<=0 || memcmp(chunk,bytes+offset,(size_t)n)) { close(fd); errno=EEXIST; return -1; }
    offset+=(size_t)n;
  }
  if(fsync(fd)<0) { int error=errno; close(fd); errno=error; return -1; }
  return close(fd);
}
static int verify_directory(const char *root,const char *bee,int original) {
  int current=bee_directory(root,bee,0);
  if(current<0) return -1;
  struct stat before,after;
  int error=0;
  if(fstat(original,&before)<0 || fstat(current,&after)<0) error=errno;
  else if(before.st_dev!=after.st_dev || before.st_ino!=after.st_ino) error=ESTALE;
  if(close(current)<0 && !error) error=errno;
  if(error) { errno=error; return -1; }
  return 0;
}
static int reconcile_stages(int dir,const char *id) {
  int scan=openat(dir,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(scan<0) return -1;
  DIR *entries=fdopendir(scan);
  if(!entries) { int error=errno; close(scan); errno=error; return -1; }
  char prefix[48]; snprintf(prefix,sizeof(prefix),".%s.stage.",id);
  int error=0;
  for(;;) {
    errno=0;
    struct dirent *entry=readdir(entries);
    if(!entry) { error=errno; break; }
    if(strncmp(entry->d_name,prefix,strlen(prefix))) continue;
    const char *suffix=entry->d_name+strlen(prefix);
    size_t digits=strspn(suffix,"0123456789");
    if(!digits || suffix[digits]!='.' || !suffix[digits+1] || strspn(suffix+digits+1,"0123456789")!=strlen(suffix+digits+1)) { error=EINVAL; break; }
    struct stat st;
    if(fstatat(dir,entry->d_name,&st,AT_SYMLINK_NOFOLLOW)<0) {
      if(errno==ENOENT) continue;
      error=errno; break;
    }
    if(!S_ISREG(st.st_mode) || st.st_uid!=geteuid() || (st.st_mode&0777)!=0600) { error=EPERM; break; }
    if(unlinkat(dir,entry->d_name,0)<0 && errno!=ENOENT) { error=errno; break; }
  }
  if(closedir(entries)<0 && !error) error=errno;
  if(!error && fsync(dir)<0) error=errno;
  if(error) { errno=error; return -1; }
  return 0;
}
static int args(napi_env env,napi_callback_info info,napi_value *a,char *root,char *bee,char *id,size_t count) {
  size_t n=count, length;
  if(napi_get_cb_info(env,info,&n,a,NULL,NULL)!=napi_ok || n!=count) return 0;
  if(napi_get_value_string_utf8(env,a[0],root,4097,&length)!=napi_ok || length==0 || length>4096 || strlen(root)!=length) return 0;
  if(napi_get_value_string_utf8(env,a[1],bee,66,&length)!=napi_ok || !opaque(bee,64,0)) return 0;
  if(napi_get_value_string_utf8(env,a[2],id,38,&length)!=napi_ok || !opaque(id,36,1)) return 0;
  return 1;
}
static napi_value publish(napi_env env,napi_callback_info info) {
  napi_value a[4]; char root[4097],bee[66],id[38]; void *data; size_t length;
  if(!args(env,info,a,root,bee,id,4) || napi_get_buffer_info(env,a[3],&data,&length)!=napi_ok || length>LIMIT) { errno=EINVAL; return failure(env,"delivery_file_invalid"); }
  int dir=bee_directory(root,bee,1);
  if(dir<0) return failure(env,"delivery_file_directory");
  char final[48],stage[100]; snprintf(final,sizeof(final),"%s.txt",id);
  if(equal_file(dir,final,data,length)==0) {
    int error=reconcile_stages(dir,id)<0?errno:0;
    if(!error && verify_directory(root,bee,dir)<0) error=errno;
    if(close(dir)<0 && !error) error=errno;
    if(error) { errno=error; return failure(env,"delivery_file_reconcile"); }
    napi_value yes; napi_get_boolean(env,true,&yes); return yes;
  }
  if(errno!=ENOENT) { int error=errno;close(dir);errno=error;return failure(env,"delivery_file_conflict"); }
  int fd=-1;
  for(unsigned int attempt=0;attempt<32 && fd<0;attempt++) {
    snprintf(stage,sizeof(stage),".%s.stage.%ld.%lu",id,(long)getpid(),atomic_fetch_add(&sequence,1));
    fd=openat(dir,stage,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
    if(fd<0 && errno!=EEXIST) break;
  }
  if(fd<0) { int error=errno;close(dir);errno=error;return failure(env,"delivery_file_create"); }
  size_t offset=0; int error=0;
  if(fchmod(fd,0600)<0) error=errno;
  while(!error && offset<length) {
    ssize_t n=write(fd,(unsigned char *)data+offset,length-offset);
    if(n<0 && errno==EINTR) continue;
    if(n<=0) error=errno?errno:EIO; else offset+=(size_t)n;
  }
  if(!error && fsync(fd)<0) error=errno;
  if(close(fd)<0 && !error) error=errno;
  if(!error && linkat(dir,stage,dir,final,0)<0) {
    int link_error=errno;
    if((link_error!=EEXIST && link_error!=ENOENT) || equal_file(dir,final,data,length)<0) error=link_error;
  }
  if(unlinkat(dir,stage,0)<0 && errno!=ENOENT && !error) error=errno;
  if(!error && reconcile_stages(dir,id)<0) error=errno;
  if(!error && verify_directory(root,bee,dir)<0) error=errno;
  if(close(dir)<0 && !error) error=errno;
  if(error) { errno=error;return failure(env,"delivery_file_publish"); }
  napi_value yes; napi_get_boolean(env,true,&yes); return yes;
}
static napi_value remove_file(napi_env env,napi_callback_info info) {
  napi_value a[3]; char root[4097],bee[66],id[38];
  if(!args(env,info,a,root,bee,id,3)) { errno=EINVAL;return failure(env,"delivery_file_invalid"); }
  int dir=bee_directory(root,bee,0);
  if(dir<0 && errno!=ENOENT) return failure(env,"delivery_file_directory");
  if(dir>=0) {
    char final[48];snprintf(final,sizeof(final),"%s.txt",id);
    if(reconcile_stages(dir,id)<0) { int error=errno;close(dir);errno=error;return failure(env,"delivery_file_remove"); }
    if(unlinkat(dir,final,0)<0 && errno!=ENOENT) { int error=errno;close(dir);errno=error;return failure(env,"delivery_file_remove"); }
    if(fsync(dir)<0) { int error=errno;close(dir);errno=error;return failure(env,"delivery_file_remove"); }
    if(close(dir)<0) return failure(env,"delivery_file_remove");
  }
  int base=root_directory(root);
  if(base<0) return failure(env,"delivery_file_directory");
  int files=directory(base,"delivery-content",0),error=0;
  if(files<0 && errno!=ENOENT) error=errno;
  if(close(base)<0 && !error) error=errno;
  if(files>=0) {
    if(!error && unlinkat(files,bee,AT_REMOVEDIR)<0 && errno!=ENOENT && errno!=ENOTEMPTY && errno!=EEXIST) error=errno;
    if(!error && fsync(files)<0) error=errno;
    if(close(files)<0 && !error) error=errno;
  }
  if(error) { errno=error; return failure(env,"delivery_file_remove"); }
  napi_value yes;napi_get_boolean(env,true,&yes);return yes;
}
static napi_value read_regular(napi_env env,napi_callback_info info) {
  napi_value a[3]; size_t count=3,length; char root[4097],path[4097]; uint32_t cap;
  if(napi_get_cb_info(env,info,&count,a,NULL,NULL)!=napi_ok || count!=3 ||
     napi_get_value_string_utf8(env,a[0],root,sizeof(root),&length)!=napi_ok || !length || length>4096 || strlen(root)!=length ||
     napi_get_value_string_utf8(env,a[1],path,sizeof(path),&length)!=napi_ok || !length || length>4096 || strlen(path)!=length || path[0]=='/' ||
     napi_get_value_uint32(env,a[2],&cap)!=napi_ok || !cap || cap>LIMIT) {
    errno=EINVAL; return failure(env,"host_file_invalid");
  }
  struct timespec start,current;
  if(clock_gettime(CLOCK_MONOTONIC,&start)<0) return failure(env,"host_file_clock");
  int fd=root_directory(root),error=fd<0?errno:0; char *save=NULL;
  unsigned depth=0;
  for(char *part=strtok_r(path,"/",&save); part && !error; part=strtok_r(NULL,"/",&save)) {
    if(++depth>64 || !strcmp(part,".") || !strcmp(part,"..")) {error=EINVAL; break;}
    int last=!save || !*save;
    int next=openat(fd,part,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC|(last?0:O_DIRECTORY));
    if(next<0) {error=errno; break;}
    if(close(fd)<0) {error=errno;close(next);fd=-1;break;}
    fd=next;
  }
  struct stat before,after;
  if(!error && (fstat(fd,&before)<0 || !S_ISREG(before.st_mode) || before.st_size<0 || before.st_size>(off_t)cap)) error=EFBIG;
  unsigned char *bytes=NULL; size_t used=0;
  if(!error) {bytes=malloc((size_t)before.st_size+1); if(!bytes) error=ENOMEM;}
  while(!error && used<(size_t)before.st_size) {
    if(clock_gettime(CLOCK_MONOTONIC,&current)<0) {error=errno;break;}
    if((current.tv_sec-start.tv_sec)*1000000000LL+current.tv_nsec-start.tv_nsec>=1000000000LL) {error=ETIMEDOUT;break;}
    size_t remaining=(size_t)before.st_size-used;
    ssize_t got=read(fd,bytes+used,remaining>65536?65536:remaining);
    if(got<0 && errno==EINTR) continue;
    if(got<=0) {error=got<0?errno:ESTALE;break;}
    used+=(size_t)got;
  }
  if(!error && (fstat(fd,&after)<0 || before.st_dev!=after.st_dev || before.st_ino!=after.st_ino || before.st_size!=after.st_size || before.st_mtime!=after.st_mtime || before.st_ctime!=after.st_ctime)) error=ESTALE;
  if(fd>=0 && close(fd)<0 && !error) error=errno;
  napi_value result=NULL;
  if(!error && napi_create_buffer_copy(env,used,bytes,NULL,&result)!=napi_ok) error=ENOMEM;
  free(bytes);
  if(error) {errno=error;return failure(env,"host_file_refused");}
  return result;
}
static napi_value init(napi_env env,napi_value exports) {
  napi_value fn;napi_create_function(env,"publish",NAPI_AUTO_LENGTH,publish,NULL,&fn);napi_set_named_property(env,exports,"publish",fn);
  napi_create_function(env,"remove",NAPI_AUTO_LENGTH,remove_file,NULL,&fn);napi_set_named_property(env,exports,"remove",fn);
  napi_create_function(env,"readRegular",NAPI_AUTO_LENGTH,read_regular,NULL,&fn);napi_set_named_property(env,exports,"readRegular",fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
