/* Link-time sysctl fault injection: production helper logic runs unchanged. */
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int census_test_sysctl(int *name, u_int namelen, void *oldp, size_t *oldlenp, void *newp, size_t newlen) {
    (void)name; (void)namelen; (void)newp; (void)newlen;
    const char *mode = getenv("CENSUS_TEST_FAULT");
    if (strcmp(mode, "denied") == 0) { errno = EPERM; return -1; }
    if (!oldp) { *oldlenp = sizeof(struct kinfo_proc); return 0; }
    if (strcmp(mode, "growth") == 0) { errno = ENOMEM; return -1; }
    struct kinfo_proc *row = oldp;
    memset(row, 0, sizeof(*row));
    row->kp_proc.p_pid = getpid();
    row->kp_proc.p_stat = SRUN;
    row->kp_proc.p_starttime.tv_sec = 1700000000;
    *oldlenp = sizeof(*row);
    if (strcmp(mode, "truncated") == 0) *oldlenp -= 1;
    if (strcmp(mode, "empty") == 0) *oldlenp = 0;
    if (strcmp(mode, "missing-self") == 0) row->kp_proc.p_pid = 1;
    if (strcmp(mode, "bad-state") == 0) row->kp_proc.p_stat = 99;
    return 0;
}
