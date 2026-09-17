/* Read-only, unprivileged macOS process census. No libproc per-PID queries:
 * KERN_PROC_ALL gives topology and birth in one kernel snapshot, including
 * zombies and reparented/detached children. The Cell policy already permits
 * kern.proc.all; /bin/ps itself cannot exec under that policy on macOS 26.
 */
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_CENSUS_BYTES (64 * 1024 * 1024)

static char state_char(int state) {
    switch (state) {
        case SIDL: return 'I';
        case SRUN: return 'R';
        case SSLEEP: return 'S';
        case SSTOP: return 'T';
        case SZOMB: return 'Z';
        default: return '\0';
    }
}

static int fail(const char *message) {
    fprintf(stderr, "process-census: %s\n", message);
    return 2;
}

int main(int argc, char **argv) {
    int identity = argc == 2 && strcmp(argv[1], "--identity") == 0;
    if (argc != 1 && !identity) return fail("usage: process-census [--identity]");
    int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 };
    struct kinfo_proc *rows = NULL;
    size_t bytes = 0;
    int complete = 0;
    /* A growing process table returns ENOMEM. Discard that partial snapshot
     * and retry with fresh sizing; never emit partial success. */
    for (int attempt = 0; attempt < 8; attempt++) {
        size_t required = 0;
        if (sysctl(mib, 4, NULL, &required, NULL, 0) != 0) return fail(strerror(errno));
        if (required == 0 || required > MAX_CENSUS_BYTES / 2) return fail("invalid census size");
        bytes = required * 2;
        rows = malloc(bytes);
        if (!rows) return fail("allocation failed");
        if (sysctl(mib, 4, rows, &bytes, NULL, 0) == 0) { complete = 1; break; }
        int error = errno;
        free(rows);
        rows = NULL;
        if (error != ENOMEM) return fail(strerror(error));
    }
    if (!complete) return fail("process table kept growing; no complete census");
    if (bytes == 0 || bytes % sizeof(*rows) != 0) { free(rows); return fail("invalid census length"); }
    size_t count = bytes / sizeof(*rows);
    /* Validate the entire result before writing anything. A missing self is
     * evidence of an incomplete/filtered census, never an empty machine. */
    int saw_self = 0;
    for (size_t i = 0; i < count; i++) {
        struct kinfo_proc *row = &rows[i];
        if (row->kp_proc.p_pid == getpid()) saw_self = 1;
        if (row->kp_proc.p_pid < 0 || row->kp_eproc.e_ppid < 0 || row->kp_eproc.e_pgid < 0 ||
            !state_char(row->kp_proc.p_stat)) { free(rows); return fail("invalid process row"); }
        time_t birth = row->kp_proc.p_starttime.tv_sec;
        struct tm date;
        if (birth < 0 || !localtime_r(&birth, &date)) { free(rows); return fail("invalid birth time"); }
    }
    if (!saw_self) { free(rows); return fail("census omitted its own process"); }
    for (size_t i = 0; i < count; i++) {
        struct kinfo_proc *row = &rows[i];
        time_t birth = row->kp_proc.p_starttime.tv_sec;
        struct tm date;
        char started[64];
        localtime_r(&birth, &date);
        /* C locale is the C runtime default. Match LC_ALL=C ps lstart,
         * including its local timezone and second-level birth precision. */
        if (!strftime(started, sizeof(started), "%a %b %e %H:%M:%S %Y", &date)) {
            free(rows); return fail("birth formatting failed");
        }
        printf("%d %d %d ", row->kp_proc.p_pid, row->kp_eproc.e_ppid, row->kp_eproc.e_pgid);
        if (!identity) printf("%c ", state_char(row->kp_proc.p_stat));
        printf("%s\n", started);
    }
    free(rows);
    if (fflush(stdout) != 0 || ferror(stdout)) return fail("output failed");
    return 0;
}
