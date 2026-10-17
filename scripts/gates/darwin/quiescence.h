struct quiescence_counts { int scanned, skipped_gone, skipped_uid_changed, skipped_fd_closed, matched, failed; };
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
static int quiescence_failure(const char *call, int error, int birth, struct quiescence_counts *counts) {
  counts->failed++;
  fprintf(stderr, "{\"type\":\"QuiescenceFailure\",\"call\":\"%s\",\"errno\":\"%s\",\"errnoNumber\":%d,\"sameBirth\":%d,\"counts\":{\"scanned\":%d,\"skippedGone\":%d,\"skippedUidChanged\":%d,\"skippedFdClosed\":%d,\"matched\":%d,\"failed\":%d}}\n", call, quiescence_errno(error), error, birth, counts->scanned, counts->skipped_gone, counts->skipped_uid_changed, counts->skipped_fd_closed, counts->matched, counts->failed);
  return 4;
}
static int root_path(const char *path, const char *root) {
  size_t size = strlen(root);
  return !strncmp(path, root, size) && (!path[size] || path[size] == '/');
}
static int quiescence(int controller, const char *root) {
  struct quiescence_counts counts = {0};
  const char *failure_call = "birth";
  int failure_errno = 0, failure_birth = -1;
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
    else if (!status && matched[0]) { counts.matched++; printf("%d\t%s\n", pid, matched); }
  }
  free(pids);
  if (failed) return quiescence_failure(failure_call, failure_errno, failure_birth, &counts);
  puts("COMPLETE");
  return 0;
}

