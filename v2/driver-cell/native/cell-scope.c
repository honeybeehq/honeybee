#define _GNU_SOURCE
#include <errno.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (argc == 2 && strcmp(argv[1], "--abi") == 0) {
    printf("%d\n", abi);
    return abi < 0 ? 1 : 0;
  }
  if (argc < 3 || strcmp(argv[1], "--") != 0) {
    fputs("cell scope: expected -- command [args]\n", stderr);
    return 125;
  }
  if (abi < 6) {
    fprintf(stderr, "cell scope: Landlock ABI >= 6 required, observed %d; refusing launch\n", abi);
    return 125;
  }
  struct landlock_ruleset_attr policy = {
    .scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL,
  };
  int fd = syscall(SYS_landlock_create_ruleset, &policy, sizeof(policy), 0);
  if (fd < 0) {
    perror("cell scope: create ruleset");
    return 125;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || syscall(SYS_landlock_restrict_self, fd, 0) != 0) {
    int error = errno;
    close(fd);
    errno = error;
    perror("cell scope: restrict self");
    return 125;
  }
  close(fd);
  execvp(argv[2], &argv[2]);
  perror("cell scope: exec");
  return 126;
}
