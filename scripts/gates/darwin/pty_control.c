#define _DARWIN_C_SOURCE 1
#define _XOPEN_SOURCE 700
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static const char *error_name(int value) {
  switch (value) {
    case 0: return "NONE";
    case EPERM: return "EPERM";
    case EACCES: return "EACCES";
    case EAGAIN: return "EAGAIN";
    case ENOENT: return "ENOENT";
    case ENOTTY: return "ENOTTY";
    case EINVAL: return "EINVAL";
    case EBADF: return "EBADF";
    case EIO: return "EIO";
    case ENOMEM: return "ENOMEM";
    default: return "OTHER";
  }
}
struct foreign_outcome { char open[32]; const char *write; };
static struct foreign_outcome foreign_probe(const char *path) {
  struct foreign_outcome result;
  result.write = "NOT_RUN";
  int fd = open(path, O_WRONLY | O_NOCTTY | O_NONBLOCK | O_NOFOLLOW);
  if (fd < 0) { snprintf(result.open, sizeof(result.open), "DENIED_%s", error_name(errno)); return result; }
  strcpy(result.open, "OPENED");
  const char byte = 'G';
  ssize_t written = write(fd, &byte, 1);
  result.write = written == 1 ? "WROTE" : written < 0 ? error_name(errno) : "OTHER";
  close(fd);
  return result;
}
static const char *zero_probe(void) {
  int fd = open("/dev/zero", O_WRONLY | O_NONBLOCK | O_NOFOLLOW);
  if (fd < 0) return error_name(errno);
  close(fd);
  return "NONE";
}
static const char *fork_probe(int *exit_status) {
  int pipes[2];
  *exit_status = -1;
  if (pipe(pipes)) return error_name(errno);
  if (fcntl(pipes[1], F_SETFD, FD_CLOEXEC)) { int error = errno; close(pipes[0]); close(pipes[1]); return error_name(error); }
  pid_t child = fork();
  if (child < 0) { int error = errno; close(pipes[0]); close(pipes[1]); return error_name(error); }
  if (!child) {
    close(pipes[0]);
    char *args[] = {"/usr/bin/true", NULL};
    char *env[] = {"PATH=/usr/bin:/bin", NULL};
    execve(args[0], args, env);
    int error = errno;
    ssize_t ignored = write(pipes[1], &error, sizeof(error));
    (void)ignored;
    _exit(127);
  }
  close(pipes[1]);
  int exec_error = 0;
  ssize_t got;
  do { got = read(pipes[0], &exec_error, sizeof(exec_error)); } while (got < 0 && errno == EINTR);
  close(pipes[0]);
  int status;
  pid_t waited;
  do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited != child) return error_name(errno);
  *exit_status = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  if (got == (ssize_t)sizeof(exec_error)) return error_name(exec_error);
  return got == 0 && *exit_status == 0 ? "NONE" : "OTHER";
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--tmux-marker")) {
    if (fputs("SCG_PTY_TMUX_READY\n", stdout) == EOF || fflush(stdout)) return 95;
    for (;;) pause();
  }
  char release;
  if (argc != 2 || strncmp(argv[1], "/dev/ttys", 9) || strchr(argv[1] + 9, '/') || read(STDIN_FILENO, &release, 1) != 1 || release != '1') return 95;
  struct foreign_outcome foreign_before = foreign_probe(argv[1]);
  const char *zero = zero_probe();
  const char *opened = "NOT_RUN", *granted = "NOT_RUN", *unlocked = "NOT_RUN", *slave_open = "NOT_RUN", *tty = "NOT_RUN";
  int master = posix_openpt(O_RDWR | O_NOCTTY);
  if (master < 0) opened = error_name(errno);
  else {
    opened = "NONE";
    if (grantpt(master)) granted = error_name(errno);
    else {
      granted = "NONE";
      if (unlockpt(master)) unlocked = error_name(errno);
      else {
        unlocked = "NONE";
        char *name = ptsname(master);
        if (!name || strncmp(name, "/dev/ttys", 9) || strchr(name + 9, '/')) slave_open = "OTHER";
        else {
          int slave = open(name, O_RDWR | O_NOCTTY | O_NOFOLLOW);
          if (slave < 0) slave_open = error_name(errno);
          else {
            slave_open = "NONE";
            struct termios attributes;
            struct winsize window;
            tty = tcgetattr(slave, &attributes) || ioctl(slave, TIOCGWINSZ, &window) ? error_name(errno) : "NONE";
            close(slave);
          }
        }
      }
    }
  }
  struct foreign_outcome foreign_after = foreign_probe(argv[1]);
  if (master >= 0) close(master);
  int true_exit = -1;
  const char *fork_exec = fork_probe(&true_exit);
  printf("{\"foreignBefore\":{\"open\":\"%s\",\"write\":\"%s\"},\"foreignAfter\":{\"open\":\"%s\",\"write\":\"%s\"},\"nonTty\":\"%s\",\"posixOpenpt\":\"%s\",\"grantpt\":\"%s\",\"unlockpt\":\"%s\",\"slaveOpen\":\"%s\",\"ttyIoctl\":\"%s\",\"forkExec\":\"%s\",\"trueExit\":%d}\n", foreign_before.open, foreign_before.write, foreign_after.open, foreign_after.write, zero, opened, granted, unlocked, slave_open, tty, fork_exec, true_exit);
  return 0;
}
