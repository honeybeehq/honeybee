#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc_info.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int identity(int pid, struct proc_bsdinfo *b) {
  errno = 0;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, b, sizeof(*b)) != sizeof(*b)) return 0;
  if (!b->pbi_start_tvsec || b->pbi_start_tvusec >= 1000000) { errno = EINVAL; return 0; }
  return 1;
}
static void print_identity(int pid, struct proc_bsdinfo *b) {
  printf("%d %d %llu %llu\n", pid, b->pbi_ppid, b->pbi_start_tvsec, b->pbi_start_tvusec);
}
static int scan(int pid, unsigned long long sec, unsigned long long usec, int depth) {
  struct proc_bsdinfo b;
  if (depth > 128) return 4;
  if (!identity(pid, &b)) return errno == ESRCH ? 0 : 4;
  if (b.pbi_start_tvsec != sec || b.pbi_start_tvusec != usec) return 4;
  print_identity(pid, &b);
  int bytes = proc_listchildpids(pid, NULL, 0);
  if (bytes < 0 || bytes > 65536) return 4;
  int capacity = bytes + 4096;
  int *children = calloc(1, capacity);
  if (!children) return 4;
  int got = proc_listchildpids(pid, children, capacity);
  if (got < 0 || got >= capacity) { free(children); return 4; }
  for (int i = 0; i < got / sizeof(int); i++) {
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
  if (argc < 3) return 2;
  int pid = atoi(argv[2]);
  if (pid <= 1) return 2;
  struct proc_bsdinfo b;
  if (!strcmp(argv[1], "identity")) {
    if (!identity(pid, &b)) return errno == ESRCH ? 3 : 4;
    print_identity(pid, &b);
    return 0;
  }
  if (argc < 6) return 2;
  unsigned long long sec = strtoull(argv[4], NULL, 10), usec = strtoull(argv[5], NULL, 10);
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
