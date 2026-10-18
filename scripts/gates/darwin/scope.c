#define __STDC_WANT_LIB_EXT1__ 1
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <arpa/inet.h>
#include <sys/sysctl.h>
#include <dlfcn.h>
#include <limits.h>
#include "argv_observation.h"
#include "node_flags.h"

static void secure_zero(void *pointer, size_t size) {
#ifdef __APPLE__
  if (memset_s(pointer, size, 0, size) != 0) {
    fputs("secure zero failed\n", stderr);
    exit(4);
  }
#else
  explicit_bzero(pointer, size);
#endif
}

static int identity(int pid, struct proc_bsdinfo *b) {
  errno = 0;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, b, sizeof(*b)) != sizeof(*b)) return 0;
  if (!b->pbi_start_tvsec || b->pbi_start_tvusec >= 1000000) { errno = EINVAL; return 0; }
  return 1;
}
static void print_identity(int pid, struct proc_bsdinfo *b) {
  printf("%d %d %llu %llu\n", pid, b->pbi_ppid, b->pbi_start_tvsec, b->pbi_start_tvusec);
}
static int same_birth(int pid, unsigned long long sec, unsigned long long usec) {
  struct proc_bsdinfo b;
  if (!identity(pid, &b)) return errno == ESRCH ? 3 : 4;
  if (b.pbi_start_tvsec != sec || b.pbi_start_tvusec != usec) return 4;
  return b.pbi_status == 5 ? 3 : 0;
}
static int socket_peer(int fd) {
  uid_t uid, after_uid; gid_t gid; pid_t pid, after_pid;
  socklen_t size = sizeof(pid);
  if (getpeereid(fd, &uid, &gid) || uid != getuid() || getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) || size != sizeof(pid) || pid <= 1) return 4;
  struct proc_bsdinfo b;
  if (!identity(pid, &b) || b.pbi_uid != getuid() || same_birth(pid, b.pbi_start_tvsec, b.pbi_start_tvusec)) return 4;
  size = sizeof(after_pid);
  if (getpeereid(fd, &after_uid, &gid) || after_uid != uid || getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &after_pid, &size) || size != sizeof(after_pid) || after_pid != pid || same_birth(pid, b.pbi_start_tvsec, b.pbi_start_tvusec)) return 4;
  printf("%u ", (unsigned int)uid);
  print_identity(pid, &b);
  return 0;
}
#define CS_OPS_STATUS 0U
#define CS_PLATFORM_BINARY 0x04000000U
typedef int (*csops_function)(pid_t, unsigned int, void *, size_t);
static csops_function csops_checker(void) {
  return (csops_function)dlsym(RTLD_DEFAULT, "csops");
}
static int quiescence_sandbox_denied(int pid, unsigned long long sec, unsigned long long usec, char **paths, int *denied, int *allowed, int *errors, int *not_sandboxed, int *allowed_by_query, int *results);
#include "quiescence.h"
static int listeners(int pid, unsigned long long sec, unsigned long long usec, int connected, const char *barrier) {
  int rc = same_birth(pid, sec, usec);
  if (rc) return rc;
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (errno || size < 0 || size > 1048576) return 4;
  int capacity = size + 4096;
  struct proc_fdinfo *fds = calloc(1, capacity);
  if (!fds) return 4;
  errno = 0;
  int got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, capacity);
  if (errno || got < 0 || got >= capacity || got % sizeof(*fds)) { free(fds); return 4; }
  for (int i = 0; i < got / sizeof(*fds); i++) {
    if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
    rc = same_birth(pid, sec, usec);
    if (rc) { free(fds); return rc; }
    struct socket_fdinfo info;
    errno = 0;
    if (proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &info, sizeof(info)) != sizeof(info)) {
      fprintf(stderr, "socket read fd=%d errno=%d\n", fds[i].proc_fd, errno);
      free(fds); return 4;
    }
    rc = same_birth(pid, sec, usec);
    if (rc) { free(fds); return rc; }
    struct socket_info *s = &info.psi;
    if (connected && barrier && s->soi_family == AF_UNIX && s->soi_kind == SOCKINFO_UN) {
      const char *remote = s->soi_proto.pri_un.unsi_caddr.ua_sun.sun_path;
      size_t bound = sizeof(s->soi_proto.pri_un.unsi_caddr.ua_sun.sun_path);
      if (strnlen(remote, bound) < bound && !strcmp(remote, barrier)) printf("%d UNIX gate-barrier 0\n", fds[i].proc_fd);
    }
    if (s->soi_family != AF_INET && s->soi_family != AF_INET6) continue;
    const struct in_sockinfo *in = NULL;
    const char *proto = NULL;
    if (s->soi_protocol == IPPROTO_TCP && s->soi_kind == SOCKINFO_TCP && (connected ? s->soi_proto.pri_tcp.tcpsi_state != TSI_S_LISTEN : s->soi_proto.pri_tcp.tcpsi_state == TSI_S_LISTEN)) {
      proto = "TCP"; in = &s->soi_proto.pri_tcp.tcpsi_ini;
    } else if (s->soi_protocol == IPPROTO_UDP && s->soi_kind == SOCKINFO_IN) {
      proto = "UDP"; in = &s->soi_proto.pri_in;
    }
    if (!in || !(connected ? in->insi_fport : in->insi_lport)) continue;
    char address[INET6_ADDRSTRLEN];
    int family = (in->insi_vflag & INI_IPV4) ? AF_INET : AF_INET6;
    const void *local = connected ? (family == AF_INET ? (const void *)&in->insi_faddr.ina_46.i46a_addr4 : (const void *)&in->insi_faddr.ina_6) : (family == AF_INET ? (const void *)&in->insi_laddr.ina_46.i46a_addr4 : (const void *)&in->insi_laddr.ina_6);
    if (!inet_ntop(family, local, address, sizeof(address))) { free(fds); return 4; }
    printf("%d %s %s %u\n", fds[i].proc_fd, proto, address, ntohs((unsigned short)(connected ? in->insi_fport : in->insi_lport)));
  }
  free(fds);
  return same_birth(pid, sec, usec);
}
static int group_members(int pid, unsigned long long sec, unsigned long long usec, int sig, int allowed_count, char **allowed) {
  int rc = same_birth(pid, sec, usec);
  if (rc) return rc;
  struct proc_bsdinfo leader;
  if (!identity(pid, &leader) || leader.pbi_pgid != (unsigned int)pid) return 4;
  errno = 0;
  int size = proc_listpids(PROC_PGRP_ONLY, (unsigned int)pid, NULL, 0);
  if (errno || size <= 0 || size > 1048576) return 4;
  int capacity = size + 4096;
  int *members = calloc(1, capacity);
  if (!members) return 4;
  errno = 0;
  int got = proc_listpids(PROC_PGRP_ONLY, (unsigned int)pid, members, capacity);
  if (errno || got <= 0 || got >= capacity || got % sizeof(*members)) { free(members); return 4; }
  for (size_t index = 0; index < (size_t)got / sizeof(*members); index++) {
    struct proc_bsdinfo member;
    if (!members[index]) continue;
    if (!identity(members[index], &member) || member.pbi_pgid != (unsigned int)pid) { free(members); return 4; }
    if (sig) {
      int matched = 0;
      for (int item = 0; item < allowed_count; item++) {
        int expected_pid = 0;
        unsigned long long expected_sec = 0, expected_usec = 0;
        char extra;
        if (sscanf(allowed[item], "%d:%llu:%llu%c", &expected_pid, &expected_sec, &expected_usec, &extra) != 3) { free(members); return 4; }
        if (expected_pid == members[index] && expected_sec == member.pbi_start_tvsec && expected_usec == member.pbi_start_tvusec) matched = 1;
      }
      if (!matched) { free(members); return 4; }
    } else print_identity(members[index], &member);
  }
  free(members);
  rc = same_birth(pid, sec, usec);
  if (rc) return rc;
  if (sig && kill(-pid, sig)) return 4;
  if (sig) puts("same-birth-own-group-signalled");
  return 0;
}
typedef int (*sandbox_check_function)(pid_t, const char *, int, ...);
static sandbox_check_function sandbox_checker(void) {
  return (sandbox_check_function)dlsym(RTLD_DEFAULT, "sandbox_check");
}
static int quiescence_sandbox_denied(int pid, unsigned long long sec, unsigned long long usec, char **paths, int *denied, int *allowed, int *errors, int *not_sandboxed, int *allowed_by_query, int *results) {
  char canonical[PATH_MAX], parent[PATH_MAX];
  for (int index = 0; index < 3; index++) if (!realpath(paths[index], canonical) || strcmp(canonical, paths[index])) { (*errors)++; return 0; }
  if (strlen(paths[3]) >= sizeof(parent)) { (*errors)++; return 0; }
  strcpy(parent, paths[3]);
  char *slash = strrchr(parent, '/');
  if (!slash || !slash[1]) { (*errors)++; return 0; }
  *slash = 0;
  if (!realpath(parent, canonical) || strcmp(parent, canonical)) { (*errors)++; return 0; }
  errno = 0;
  if (realpath(paths[3], canonical) || errno != ENOENT) { (*errors)++; return 0; }
  sandbox_check_function check = sandbox_checker();
  if (!check || same_birth(pid, sec, usec)) { (*errors)++; return 0; }
  errno = 0;
  int sandboxed = check(pid, NULL, 0);
  int error = errno;
  if (error || (sandboxed != 0 && sandboxed != 1) || same_birth(pid, sec, usec)) { (*errors)++; return 0; }
  if (!sandboxed) { (*not_sandboxed)++; return 0; }
  int had_allowed = 0, writes_denied = 1;
  const char *operations[] = {"file-read-data", "file-write-data", "file-write-create", "file-write-unlink"};
  for (int slot = 0; slot < 16; slot++) {
    int path = slot < 8 ? slot / 2 : (slot - 8) / 2;
    int operation = slot < 8 ? slot % 2 : 2 + (slot - 8) % 2;
    if (same_birth(pid, sec, usec)) { results[slot] = -1; (*errors)++; return 0; }
    errno = 0;
    int result = check(pid, operations[operation], 1, paths[path]);
    error = errno;
    if (error || (result != 0 && result != 1) || same_birth(pid, sec, usec)) { results[slot] = -1; (*errors)++; return 0; }
    results[slot] = result;
    if (!result) { (*allowed)++; allowed_by_query[slot]++; had_allowed = 1; if (operation) writes_denied = 0; }
    else (*denied)++;
    if (slot == 7 && !had_allowed) return 1;
  }
  if (same_birth(pid, sec, usec)) { (*errors)++; return 0; }
  return writes_denied ? 2 : 0;

}
static int node_observation(int pid, unsigned long long sec, unsigned long long usec, const char *expected_node, const char *reader, const char *preloader, const char *test, const char *host) {
  int rc = same_birth(pid, sec, usec);
  if (rc) return rc;
  size_t capacity = 1048576, size = capacity, count = 0, entry = 0;
  unsigned char *buffer = calloc(1, capacity);
  if (!buffer) { fputs("procargs_read\n", stderr); return 4; }
  struct argv_span args[1024];
  char image[PROC_PIDPATHINFO_MAXSIZE], cwd[PATH_MAX], resolved_entry[PATH_MAX], candidate[PATH_MAX], bad[96] = "missing_entry";
  const char *reason = "procargs_read";
  rc = 4;
  do {
    if (proc_pidpath(pid, image, sizeof(image)) <= 0 || strcmp(image, expected_node)) { reason = "entry_mismatch"; break; }
    int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
    errno = 0;
    int got = sysctl(mib, 3, buffer, &size, NULL, 0);
    int identity_status = same_birth(pid, sec, usec);
    if (got || identity_status || size >= capacity || size < sizeof(int)) { if (identity_status) rc = identity_status; break; }
    int argc = 0; memcpy(&argc, buffer, sizeof(argc));
    if (argc <= 0 || argc > 1024) { reason = "argc_bound"; break; }
    if (!parse_argv_only(buffer, size, args, 1024, &count)) break;
    if (!node_flags_entry(buffer, args, count, preloader, &entry, bad)) {
      if (entry >= count) { reason = "entry_mismatch"; break; }
      fprintf(stderr, "unsupported_flag:%s\n", bad);
      print_node_flags(stderr, buffer, args, count, count, preloader, 0);
      reason = NULL;
      break;
    }
    struct proc_vnodepathinfo paths;
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &paths, sizeof(paths)) != sizeof(paths) || !realpath(paths.pvi_cdir.vip_path, cwd)) { reason = "cwd_read"; break; }
    int printed = snprintf(candidate, sizeof(candidate), "%s%s%s", buffer[args[entry].start] == '/' ? "" : cwd, buffer[args[entry].start] == '/' ? "" : "/", buffer + args[entry].start);
    if (printed <= 0 || printed >= (int)sizeof(candidate) || !realpath(candidate, resolved_entry)) { reason = "entry_mismatch"; break; }
    if (!node_role_argv(buffer, args, count, entry, expected_node, reader, preloader, test, host, resolved_entry, bad)) {
      if (!strcmp(bad, "--experimental-strip-types")) { fprintf(stderr, "unsupported_flag:%s\n", bad); reason = NULL; }
      else reason = "entry_mismatch";
      break;
    }
    sandbox_check_function check = sandbox_checker();
    if (!check) { reason = "sandbox_read"; break; }
    errno = 0;
    int sandboxed = check(pid, NULL, 0);
    if (errno || (sandboxed != 0 && sandboxed != 1)) { reason = "sandbox_read"; break; }
    rc = same_birth(pid, sec, usec);
    if (rc) break;
    if (proc_pidpath(pid, image, sizeof(image)) <= 0 || strcmp(image, expected_node)) { rc = 4; reason = "entry_mismatch"; break; }
    for (const char *part = cwd; *part; part++) if (*part <= 32 || *part >= 127) { rc = 4; reason = "cwd_read"; break; }
    if (rc) break;
    for (const char *part = resolved_entry; *part; part++) if (*part <= 32 || *part >= 127) { rc = 4; reason = "entry_mismatch"; break; }
    if (rc) break;
    printf("NODE %s\nENTRY %s\nCWD %s\nSANDBOX %d\n", image, resolved_entry, cwd, sandboxed);
    print_node_flags(stdout, buffer, args, count, entry, preloader, 1);
    reason = NULL;
  } while (0);
  if (rc && reason) fprintf(stderr, "%s\n", reason);
  secure_zero(buffer, capacity);
  free(buffer);
  return rc ? rc : same_birth(pid, sec, usec);
}

static int write_policy(int pid, unsigned long long sec, unsigned long long usec, char **paths) {
  sandbox_check_function check = sandbox_checker();
  if (!check) { fputs("sandbox_check SPI unavailable\n", stderr); return 4; }
  int results[3];
  for (int index = 0; index < 3; index++) {
    int rc = same_birth(pid, sec, usec);
    if (rc) return rc;
    char canonical[PATH_MAX];
    if (!realpath(paths[index], canonical) || strcmp(canonical, paths[index])) return 4;
    errno = 0;
    results[index] = check(pid, "file-write-data", 1, canonical);
    if (errno || (results[index] != 0 && results[index] != 1)) { fprintf(stderr, "sandbox_check write-policy index=%d result=%d errno=%d\n", index, results[index], errno); return 4; }
    rc = same_birth(pid, sec, usec);
    if (rc) return rc;
  }
  printf("CELL %d\nCONTENT %d\nSEALED %d\n", results[0], results[1], results[2]);
  return same_birth(pid, sec, usec);
}
static int scan(int pid, unsigned long long sec, unsigned long long usec, int depth) {
  struct proc_bsdinfo b;
  if (depth > 128) return 4;
  if (!identity(pid, &b)) return errno == ESRCH ? 0 : 4;
  if (b.pbi_start_tvsec != sec || b.pbi_start_tvusec != usec) return 4;
  print_identity(pid, &b);
  errno = 0;
  int count = proc_listchildpids(pid, NULL, 0);
  if (errno || count < 0 || count > 16384) return 4;
  int capacity = count + 1024;
  int *children = calloc(capacity, sizeof(*children));
  if (!children) return 4;
  errno = 0;
  int got = proc_listchildpids(pid, children, capacity * sizeof(*children));
  if (errno || got < 0 || got >= capacity) { free(children); return 4; }
  for (int i = 0; i < got; i++) {
    struct proc_bsdinfo child;
    if (!children[i]) continue;
    if (!identity(children[i], &child)) {
      int error = errno;
      fprintf(stderr, "child identity read pid=%d parent=%d errno=%d\n", children[i], pid, error);
      if (error == ESRCH) continue;
      free(children); return 4;
    }
    if (child.pbi_ppid != pid) continue;
    int rc = scan(children[i], child.pbi_start_tvsec, child.pbi_start_tvusec, depth + 1);
    if (rc) { free(children); return rc; }
  }
  free(children);
  return 0;
}
int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "peer-fd")) {
    char *end; long fd = strtol(argv[2], &end, 10);
    return !*end && fd >= 3 && fd <= INT_MAX ? socket_peer((int)fd) : 2;
  }
  if (argc < 3) return 2;
  int pid = atoi(argv[2]);
  if (pid <= 1) return 2;
  struct proc_bsdinfo b;
  if (!strcmp(argv[1], "identity")) {
    if (!identity(pid, &b)) return errno == ESRCH ? 3 : 4;
    print_identity(pid, &b);
    return 0;
  }
  if (!strcmp(argv[1], "quiescence")) {
    char *end = NULL;
    errno = 0;
    unsigned long long created = argc == 8 ? strtoull(argv[4], &end, 10) : 0;
    return !errno && created && end && !*end ? quiescence(pid, argv[3], created, (char *[]){argv[3], argv[5], argv[6], argv[7]}) : 2;
  }
  if (argc < 6) return 2;
  unsigned long long sec = strtoull(argv[4], NULL, 10), usec = strtoull(argv[5], NULL, 10);
  if (!strcmp(argv[1], "group")) return group_members(pid, sec, usec, 0, 0, NULL);
  if (!strcmp(argv[1], "signal-group")) {
    if (argc < 8) return 2;
    int sig = atoi(argv[6]);
    if (sig != SIGTERM && sig != SIGKILL) return 2;
    return group_members(pid, sec, usec, sig, argc - 7, argv + 7);
  }
  if (!strcmp(argv[1], "node-observation")) return (argc == 9 || argc == 11) ? node_observation(pid, sec, usec, argv[6], argv[7], argv[8], argc == 11 ? argv[9] : NULL, argc == 11 ? argv[10] : NULL) : 2;
  if (!strcmp(argv[1], "write-policy")) return argc == 9 ? write_policy(pid, sec, usec, argv + 6) : 2;
  if (!strcmp(argv[1], "listeners")) return listeners(pid, sec, usec, 0, NULL);
  if (!strcmp(argv[1], "connections")) return listeners(pid, sec, usec, 1, argc == 7 ? argv[6] : NULL);
  if (!strcmp(argv[1], "executable")) {
    int rc = same_birth(pid, sec, usec);
    if (rc) return rc;
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(pid, path, sizeof(path)) <= 0) { rc = same_birth(pid, sec, usec); return rc ? rc : 4; }
    rc = same_birth(pid, sec, usec);
    if (rc) return rc;
    puts(path);
    return 0;
  }
  if (!strcmp(argv[1], "scan")) return scan(pid, sec, usec, 0);
  if (!strcmp(argv[1], "status")) {
    if (!identity(pid, &b)) { int error = errno; puts(error == ESRCH ? "gone" : "unobserved-refused"); return error == ESRCH ? 3 : 4; }
    if (b.pbi_start_tvsec != sec || b.pbi_start_tvusec != usec) { puts("birth-mismatch-refused"); return 4; }
    if (b.pbi_status == 5) { puts("same-birth-zombie"); return 3; }
    puts("same-birth-alive"); return 0;
  }
  if (strcmp(argv[1], "signal") || argc != 7) return 2;
  int sig = atoi(argv[6]);
  if (sig != SIGTERM && sig != SIGKILL) return 2;
  if (!identity(pid, &b)) { int error = errno; puts(error == ESRCH ? "gone" : "unobserved-refused"); return error == ESRCH ? 3 : 4; }
  if (b.pbi_start_tvsec != sec || b.pbi_start_tvusec != usec) { puts("birth-mismatch-refused"); return 4; }
  if (b.pbi_status == 5) { puts("same-birth-zombie"); return 3; }
  if (kill(pid, sig)) { puts("signal-refused"); return 4; }
  puts("same-birth-signalled");
  return 0;
}
#else
int main(void) { return 77; }
#endif
