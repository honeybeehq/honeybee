#define _GNU_SOURCE
#include <errno.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

struct hb_landlock_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};
#define HB_LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define HB_LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define HB_LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
_Static_assert(sizeof(struct hb_landlock_ruleset_attr) == 24, "Landlock ABI 6 ruleset size");
_Static_assert(offsetof(struct hb_landlock_ruleset_attr, scoped) == 16, "Landlock ABI 6 scope offset");
#ifdef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
_Static_assert(HB_LANDLOCK_CREATE_RULESET_VERSION == LANDLOCK_CREATE_RULESET_VERSION, "Landlock version flag mismatch");
_Static_assert(HB_LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET == LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET, "Landlock abstract scope mismatch");
_Static_assert(HB_LANDLOCK_SCOPE_SIGNAL == LANDLOCK_SCOPE_SIGNAL, "Landlock signal scope mismatch");
_Static_assert(offsetof(struct hb_landlock_ruleset_attr, scoped) == offsetof(struct landlock_ruleset_attr, scoped), "Landlock scope layout mismatch");
#endif

int main(int argc, char **argv) {
  if (argc >= 5 && strcmp(argv[1], "--assert-userns") == 0 && strcmp(argv[3], "--") == 0) {
    struct stat info;
    char current[96];
    if (stat("/proc/self/ns/user", &info) != 0) {
      perror("cell scope: user namespace unavailable");
      return 125;
    }
    snprintf(current, sizeof(current), "%ju:%ju", (uintmax_t)info.st_dev, (uintmax_t)info.st_ino);
    if (strcmp(current, argv[2]) == 0) {
      fputs("cell scope: user namespace unchanged; refusing launch\n", stderr);
      return 125;
    }
    execvp(argv[4], &argv[4]);
    perror("cell scope: exec");
    return 126;
  }
  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, HB_LANDLOCK_CREATE_RULESET_VERSION);
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
  struct hb_landlock_ruleset_attr policy = {
    .scoped = HB_LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | HB_LANDLOCK_SCOPE_SIGNAL,
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
