struct quiescence_counts { int scanned, skipped_gone, skipped_uid_changed, skipped_fd_closed, matched, failed, exe_unlinked_pre_root, region_compared, region_unavailable, session_leader_not_uid_listed, fd_unobservable, fd_non_gate_failed, fd_clean_failed, fd_sandbox_failed, fd_denied_queries, fd_allowed_queries, fd_query_errors, fd_not_sandboxed; };
static const char *quiescence_errno(int value) {
  switch (value) {
    case 0: return "NONE";
    case EPERM: return "EPERM";
    case EACCES: return "EACCES";
    case ESRCH: return "ESRCH";
    case EBADF: return "EBADF";
    case ENOENT: return "ENOENT";
    case EINVAL: return "EINVAL";
    case ENOMEM: return "ENOMEM";
    case EINTR: return "EINTR";
    default: return "OTHER";
  }
}
static int quiescence_report(const char *call, int error, int birth, struct quiescence_counts *counts) {
  fprintf(stderr, "{\"type\":\"%s\",\"call\":\"%s\",\"errno\":\"%s\",\"errnoNumber\":%d,\"sameBirth\":%d,\"counts\":{\"scanned\":%d,\"skippedGone\":%d,\"skippedUidChanged\":%d,\"skippedFdClosed\":%d,\"matched\":%d,\"failed\":%d,\"exeUnlinkedPreRoot\":%d,\"regionCompared\":%d,\"regionUnavailable\":%d,\"sessionLeaderNotUidListed\":%d,\"fdUnobservableSandboxDenied\":%d,\"fdNonGateFailed\":%d,\"fdCleanFailed\":%d,\"fdSandboxFailed\":%d,\"fdDeniedQueries\":%d,\"fdAllowedQueries\":%d,\"fdQueryErrors\":%d,\"fdNotSandboxed\":%d}}\n", counts->failed ? "QuiescenceFailure" : "QuiescenceComplete", call, quiescence_errno(error), error, birth, counts->scanned, counts->skipped_gone, counts->skipped_uid_changed, counts->skipped_fd_closed, counts->matched, counts->failed, counts->exe_unlinked_pre_root, counts->region_compared, counts->region_unavailable, counts->session_leader_not_uid_listed, counts->fd_unobservable, counts->fd_non_gate_failed, counts->fd_clean_failed, counts->fd_sandbox_failed, counts->fd_denied_queries, counts->fd_allowed_queries, counts->fd_query_errors, counts->fd_not_sandboxed);
  return counts->failed ? 4 : 0;
}
static int quiescence_failure(const char *call, int error, int birth, struct quiescence_counts *counts) {
  counts->failed = 1;
  return quiescence_report(call, error, birth, counts);
}
static int root_path(const char *path, const char *root) {
  size_t size = strlen(root);
  return !strncmp(path, root, size) && (!path[size] || path[size] == '/');
}
struct root_inode { unsigned long long dev, ino; };
static struct root_inode root_inodes[1000000];
static int gate_launch_pids[1000000], gate_launch_count;
static int unlinked_session(int pid, struct proc_bsdinfo *birth, int controller, int *pids, int count, unsigned long long created, struct quiescence_counts *counts, int count_unlisted) {
  struct proc_bsdinfo owner, current;
  if (pid == controller || !identity(controller, &owner) || birth->pbi_start_tvsec >= owner.pbi_start_tvsec || birth->pbi_start_tvsec >= created / 1000000 - 1) return 0;
  if (!identity(pid, &current) || current.pbi_start_tvsec != birth->pbi_start_tvsec || current.pbi_start_tvusec != birth->pbi_start_tvusec || current.pbi_uid != getuid()) return 0;
  int session = getsid(pid), owner_session = getsid(controller);
  if (session <= 0 || owner_session <= 0 || session == owner_session) return 0;
  int listed = 0;
  for (int index = 0; index < count; index++) if (pids[index] == session) listed = 1;
  if (!listed && count_unlisted) counts->session_leader_not_uid_listed++;
  for (int index = 0; index < gate_launch_count; index++) if (session == gate_launch_pids[index] || current.pbi_pgid == (unsigned int)gate_launch_pids[index]) return 0;
  return !same_birth(controller, owner.pbi_start_tvsec, owner.pbi_start_tvusec) && !same_birth(pid, birth->pbi_start_tvsec, birth->pbi_start_tvusec) && getsid(pid) == session;

}
static int unlinked_regions(int pid, struct proc_bsdinfo *birth, int inode_count, struct quiescence_counts *counts) {
  unsigned long long address = 0;
  int compared = 0;
  for (int index = 0; index < 65536; index++) {
    struct proc_regionwithpathinfo region;
    memset(&region, 0, sizeof(region));
    int got = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &region, sizeof(region));
    if (same_birth(pid, birth->pbi_start_tvsec, birth->pbi_start_tvusec)) return 0;
    if (got != (int)sizeof(region)) { if (!compared) counts->region_unavailable++; return 1; }
    unsigned long long dev = (unsigned int)region.prp_vip.vip_vi.vi_stat.vst_dev, ino = region.prp_vip.vip_vi.vi_stat.vst_ino;
    if (ino) {
      compared = 1;
      counts->region_compared++;
      for (int item = 0; item < inode_count; item++) if (root_inodes[item].dev == dev && root_inodes[item].ino == ino) return 0;
    }
    unsigned long long next = region.prp_prinfo.pri_address + region.prp_prinfo.pri_size;
    if (!region.prp_prinfo.pri_size || next <= address) { counts->region_unavailable++; return 1; }
    address = next;
  }
  counts->region_unavailable++;
  return 1;
}
static int quiescence(int controller, const char *root, unsigned long long created, char **denial_paths) {
  struct quiescence_counts counts = {0};
  const char *failure_call = "birth";
  int failure_errno = 0, failure_birth = -1;
  int inode_count = 0;
  if (created < 2000000 || scanf("%d", &inode_count) != 1 || inode_count < 0 || inode_count > 1000000) return quiescence_failure("root", EINVAL, -1, &counts);
  for (int index = 0; index < inode_count; index++) if (scanf("%llu %llu", &root_inodes[index].dev, &root_inodes[index].ino) != 2) return quiescence_failure("root", EINVAL, -1, &counts);
  if (scanf("%d", &gate_launch_count) != 1 || gate_launch_count < 0 || gate_launch_count > 1000000) return quiescence_failure("root", EINVAL, -1, &counts);
  for (int index = 0; index < gate_launch_count; index++) if (scanf("%d", &gate_launch_pids[index]) != 1 || gate_launch_pids[index] <= 0) return quiescence_failure("root", EINVAL, -1, &counts);
  char trailing;
  if (scanf(" %c", &trailing) != EOF) return quiescence_failure("root", EINVAL, -1, &counts);
  char canonical[PATH_MAX];
  if (!realpath(root, canonical) || strcmp(root, canonical)) return quiescence_failure("root", errno, -1, &counts);
  errno = 0;
  int bytes_needed = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
  if (errno || bytes_needed <= 0 || bytes_needed > 4194304 || bytes_needed % (int)sizeof(int)) return quiescence_failure("proc_listpids", errno, -1, &counts);
  int capacity = bytes_needed + 4096 * (int)sizeof(int);
  int *pids = calloc(1, (size_t)capacity);
  if (!pids) return quiescence_failure("allocation", ENOMEM, -1, &counts);
  errno = 0;
  int got_bytes = proc_listpids(PROC_UID_ONLY, getuid(), pids, capacity);
  if (errno || got_bytes <= 0 || got_bytes >= capacity || got_bytes % (int)sizeof(int)) { int error = errno; free(pids); return quiescence_failure("proc_listpids", error, -1, &counts); }
  int got = got_bytes / (int)sizeof(int);
  int failed = 0;
  for (int index = 0; index < got && !failed; index++) {
    int pid = pids[index];
    if (pid <= 0 || pid == controller || pid == getpid()) continue;
    counts.scanned++;
    struct proc_bsdinfo birth;
    if (!identity(pid, &birth)) { if (errno == ESRCH) counts.skipped_gone++; else { failed = 1; failure_call = "birth"; failure_errno = errno; } continue; }
    if (birth.pbi_uid != getuid()) { counts.skipped_uid_changed++; continue; }
    if (birth.pbi_status == 5) continue;
    struct proc_vnodepathinfo paths;
    char image[PROC_PIDPATHINFO_MAXSIZE], matched[PATH_MAX] = {0};
    int unlinked = 0, region_proven = 0, fd_unobservable = 0;
    errno = 0;
    int read_size = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &paths, sizeof(paths));
    int read_error = errno;
    const char *read_call = "pidinfo vnode";
    if (read_size == (int)sizeof(paths)) {
      errno = 0;
      read_size = proc_pidpath(pid, image, sizeof(image));
      read_error = errno;
      read_call = "pidpath";
      if (read_size > 0) read_size = sizeof(paths);
      else if (read_error == ENOENT && unlinked_session(pid, &birth, controller, pids, got, created, &counts, 1)) {
        int previous_regions = counts.region_compared;
        if (!unlinked_regions(pid, &birth, inode_count, &counts)) { failed = 1; failure_call = "region inode"; failure_errno = ENOENT; failure_birth = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec); continue; }
        region_proven = counts.region_compared > previous_regions;
        image[0] = 0;
        unlinked = 1;
        read_size = sizeof(paths);
      } else if (read_error == ENOENT) read_call = "unlinked policy";
    }
    if (read_size != (int)sizeof(paths)) {
      int status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
      if (status == 3) counts.skipped_gone++;
      else { failed = 1; failure_call = read_call; failure_errno = read_error; failure_birth = status; }
      continue;
    }
    int status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
    if (status) { if (status == 3) counts.skipped_gone++; else { failed = 1; failure_call = "birth"; failure_errno = errno; failure_birth = status; } continue; }
    const char *names[] = {paths.pvi_cdir.vip_path, image};
    for (int part = 0; part < 2; part++) if (root_path(names[part], root)) snprintf(matched, sizeof(matched), "%s", names[part]);
    errno = 0;
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (errno || bytes < 0 || bytes > 16777216) {
      int error = errno;
      status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
      if (status == 3) counts.skipped_gone++;
      else { failed = 1; failure_call = "listfds"; failure_errno = error; failure_birth = status; }
      continue;
    }
    int fd_capacity = bytes + 4096;
    struct proc_fdinfo *fds = calloc(1, fd_capacity);
    if (!fds) { failed = 1; failure_call = "allocation"; failure_errno = ENOMEM; continue; }
    errno = 0;
    int used = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, fd_capacity);
    if (errno || used < 0 || used >= fd_capacity || used % sizeof(*fds)) {
      int error = errno;
      free(fds);
      status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
      if (status == 3) counts.skipped_gone++;
      else { failed = 1; failure_call = "listfds"; failure_errno = error; failure_birth = status; }
      continue;
    }
    int gone = 0;
    for (size_t fd = 0; fd < (size_t)used / sizeof(*fds); fd++) {
      if (fds[fd].proc_fdtype != PROX_FDTYPE_VNODE) continue;
      struct vnode_fdinfowithpath vnode;
      errno = 0;
      if (proc_pidfdinfo(pid, fds[fd].proc_fd, PROC_PIDFDVNODEPATHINFO, &vnode, sizeof(vnode)) != (int)sizeof(vnode)) {
        int read_error = errno;
        status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
        if (status == 3) { gone = 1; counts.skipped_gone++; }
        else if (!status && (read_error == EBADF || read_error == ENOENT)) { counts.skipped_fd_closed++; continue; }
        else if (!status && read_error == EPERM) { fd_unobservable = 1; continue; }
        else { failed = 1; failure_call = "fdinfo"; failure_errno = read_error; failure_birth = status; }
        break;
      }
      status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
      if (status) { if (status == 3) { gone = 1; counts.skipped_gone++; } else { failed = 1; failure_call = "birth"; failure_errno = errno; failure_birth = status; } break; }
      if (root_path(vnode.pvip.vip_path, root)) snprintf(matched, sizeof(matched), "%s", vnode.pvip.vip_path);
    }
    free(fds);
    if (gone || failed) continue;
    status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
    if (status == 4) { failed = 1; failure_call = "birth"; failure_errno = errno; failure_birth = status; }
    else if (status == 3) counts.skipped_gone++;
    else if (!status && fd_unobservable) {
      failure_call = "fdinfo"; failure_errno = EPERM; failure_birth = 0;
      if (!unlinked_session(pid, &birth, controller, pids, got, created, &counts, !unlinked)) { counts.fd_non_gate_failed++; failed = 1; }
      else if (matched[0] || (unlinked && !region_proven)) { counts.fd_clean_failed++; failed = 1; }
      else if (!quiescence_sandbox_denied(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec, denial_paths, &counts.fd_denied_queries, &counts.fd_allowed_queries, &counts.fd_query_errors, &counts.fd_not_sandboxed)) { counts.fd_sandbox_failed++; failed = 1; }
      else { counts.fd_unobservable++; if (unlinked) counts.exe_unlinked_pre_root++; }
    }
    else if (!status && matched[0]) {
      if (unlinked) { failed = 1; failure_call = "unlinked policy"; failure_errno = ENOENT; failure_birth = 0; }
      else { counts.matched++; printf("%d\t%s\n", pid, matched); }
    } else if (!status && unlinked) {
      if (!unlinked_session(pid, &birth, controller, pids, got, created, &counts, 0)) { failed = 1; failure_call = "unlinked policy"; failure_errno = ENOENT; failure_birth = 0; }
      else counts.exe_unlinked_pre_root++;
    }
  }
  free(pids);
  if (failed) return quiescence_failure(failure_call, failure_errno, failure_birth, &counts);
  quiescence_report("none", 0, -1, &counts);
  puts("COMPLETE");
  return 0;
}

