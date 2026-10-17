static int root_path(const char *path, const char *root) {
  size_t size = strlen(root);
  return !strncmp(path, root, size) && (!path[size] || path[size] == '/');
}
static int quiescence(int controller, const char *root) {
  char canonical[PATH_MAX];
  if (!realpath(root, canonical) || strcmp(root, canonical)) return 4;
  errno = 0;
  int count = proc_listallpids(NULL, 0);
  if (errno || count <= 0 || count > 1048576) return 4;
  int capacity = count + 4096;
  int *pids = calloc((size_t)capacity, sizeof(*pids));
  if (!pids) return 4;
  errno = 0;
  int got = proc_listallpids(pids, capacity * (int)sizeof(*pids));
  if (errno || got <= 0 || got >= capacity) { free(pids); return 4; }
  int failed = 0;
  for (int index = 0; index < got && !failed; index++) {
    int pid = pids[index];
    if (pid <= 0 || pid == controller || pid == getpid()) continue;
    struct proc_bsdinfo birth;
    if (!identity(pid, &birth)) { if (errno != ESRCH) failed = 1; continue; }
    if (birth.pbi_uid != getuid() || birth.pbi_status == 5) continue;
    struct proc_vnodepathinfo paths;
    char image[PROC_PIDPATHINFO_MAXSIZE], matched[PATH_MAX] = {0};
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &paths, sizeof(paths)) != (int)sizeof(paths) || proc_pidpath(pid, image, sizeof(image)) <= 0) {
      if (same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec) != 3) failed = 1;
      continue;
    }
    int status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
    if (status) { if (status != 3) failed = 1; continue; }
    const char *names[] = {paths.pvi_cdir.vip_path, image};
    for (int part = 0; part < 2; part++) if (root_path(names[part], root)) snprintf(matched, sizeof(matched), "%s", names[part]);
    errno = 0;
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (errno || bytes < 0 || bytes > 16777216) {
      if (same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec) != 3) failed = 1;
      continue;
    }
    int fd_capacity = bytes + 4096;
    struct proc_fdinfo *fds = calloc(1, fd_capacity);
    if (!fds) { failed = 1; continue; }
    errno = 0;
    int used = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, fd_capacity);
    if (errno || used < 0 || used >= fd_capacity || used % sizeof(*fds)) {
      free(fds);
      if (same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec) != 3) failed = 1;
      continue;
    }
    int gone = 0;
    for (size_t fd = 0; fd < (size_t)used / sizeof(*fds); fd++) {
      if (fds[fd].proc_fdtype != PROX_FDTYPE_VNODE) continue;
      struct vnode_fdinfowithpath vnode;
      errno = 0;
      if (proc_pidfdinfo(pid, fds[fd].proc_fd, PROC_PIDFDVNODEPATHINFO, &vnode, sizeof(vnode)) != (int)sizeof(vnode)) {
        status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
        if (status == 3) gone = 1;
        else failed = 1;
        break;
      }
      status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
      if (status) { if (status == 3) gone = 1; else failed = 1; break; }
      if (root_path(vnode.pvip.vip_path, root)) snprintf(matched, sizeof(matched), "%s", vnode.pvip.vip_path);
    }
    free(fds);
    if (gone || failed) continue;
    status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
    if (status == 4) failed = 1;
    else if (!status && matched[0]) printf("%d\t%s\n", pid, matched);
  }
  free(pids);
  if (failed) return 4;
  puts("COMPLETE");
  return 0;
}

