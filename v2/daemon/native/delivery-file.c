#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <node_api.h>
#include <stdbool.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LIMIT (8u * 1024u * 1024u)
static unsigned long sequence;
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
  struct stat st;
  if (fstat(fd,&st)<0 || !S_ISDIR(st.st_mode) || st.st_uid!=getuid() || (st.st_mode&0777)!=0700) {
    close(fd); errno=EPERM; return -1;
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
    int error=errno; close(fd); fd=next; errno=error;
  }
  free(copy); return fd;
}
static int bee_directory(const char *root,const char *bee,int create) {
  int base=root_directory(root);
  if (base<0) return -1;
  int files=directory(base,"delivery-content",create), error=errno;
  close(base); errno=error;
  if (files<0) return -1;
  int result=directory(files,bee,create); error=errno;
  close(files); errno=error; return result;
}
static int equal_file(int dir,const char *name,const unsigned char *bytes,size_t length) {
  int fd=openat(dir,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
  if(fd<0) return -1;
  struct stat st;
  if(fstat(fd,&st)<0 || !S_ISREG(st.st_mode) || st.st_uid!=getuid() || (st.st_mode&0777)!=0600 || st.st_size!=(off_t)length) {
    close(fd); errno=EEXIST; return -1;
  }
  unsigned char chunk[8192]; size_t offset=0;
  while(offset<length) {
    ssize_t n=read(fd,chunk,sizeof(chunk)<length-offset?sizeof(chunk):length-offset);
    if(n<0 && errno==EINTR) continue;
    if(n<=0 || memcmp(chunk,bytes+offset,(size_t)n)) { close(fd); errno=EEXIST; return -1; }
    offset+=(size_t)n;
  }
  close(fd); return 0;
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
  if(equal_file(dir,final,data,length)==0) { close(dir); napi_value yes; napi_get_boolean(env,true,&yes); return yes; }
  if(errno!=ENOENT) { int error=errno;close(dir);errno=error;return failure(env,"delivery_file_conflict"); }
  int fd=-1;
  for(unsigned int attempt=0;attempt<32 && fd<0;attempt++) {
    snprintf(stage,sizeof(stage),".%s.stage.%ld.%lu",id,(long)getpid(),sequence++);
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
  close(fd);
  if(!error && linkat(dir,stage,dir,final,0)<0) {
    if(errno!=EEXIST || equal_file(dir,final,data,length)<0) error=errno;
  }
  unlinkat(dir,stage,0);
  if(!error && fsync(dir)<0) error=errno;
  close(dir);
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
    if(unlinkat(dir,final,0)<0 && errno!=ENOENT) { int error=errno;close(dir);errno=error;return failure(env,"delivery_file_remove"); }
    if(fsync(dir)<0) { int error=errno;close(dir);errno=error;return failure(env,"delivery_file_remove"); }
    close(dir);
  }
  napi_value yes;napi_get_boolean(env,true,&yes);return yes;
}
static napi_value init(napi_env env,napi_value exports) {
  napi_value fn;napi_create_function(env,"publish",NAPI_AUTO_LENGTH,publish,NULL,&fn);napi_set_named_property(env,exports,"publish",fn);
  napi_create_function(env,"remove",NAPI_AUTO_LENGTH,remove_file,NULL,&fn);napi_set_named_property(env,exports,"remove",fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
