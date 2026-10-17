struct quiescence_counts { int scanned, skipped_gone, skipped_uid_changed, skipped_fd_closed, matched, failed, exe_unlinked_pre_root, region_compared, region_unavailable, region_partial, region_zero_size, zero_observed, zero_share_mode, zero_submap, zero_end, session_leader_not_uid_listed, fd_unobservable, fd_non_gate_failed, fd_clean_failed, fd_sandbox_failed, fd_denied_queries, fd_allowed_queries, fd_query_errors, fd_not_sandboxed, fd_write_denied, fd_platform, platform_not, platform_path_disallowed, platform_csops_error, platform_csops_unavailable, platform_inode_match, platform_inode_unobserved, fd_read_allowed[4], fd_read_denied[4], fd_allowed_by_query[16], fd_failed_results[16], partial_errno, partial_regions, partial_image_seen, partial_kind, partial_submap, platform_failures[19]; };
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
    case EFAULT: return "EFAULT";
    case EIO: return "EIO";
    case ENOTSUP: return "ENOTSUP";
    case EOVERFLOW: return "EOVERFLOW";
    case EBUSY: return "EBUSY";
    case EAGAIN: return "EAGAIN";
    case ENOSYS: return "ENOSYS";
    default: return "OTHER";
  }
}
static const char *quiescence_share_mode(unsigned int value) {
  switch (value) {
    case SM_COW: return "SM_COW";
    case SM_PRIVATE: return "SM_PRIVATE";
    case SM_EMPTY: return "SM_EMPTY";
    case SM_SHARED: return "SM_SHARED";
    case SM_TRUESHARED: return "SM_TRUESHARED";
    case SM_PRIVATE_ALIASED: return "SM_PRIVATE_ALIASED";
    case SM_SHARED_ALIASED: return "SM_SHARED_ALIASED";
    case SM_LARGE_PAGE: return "SM_LARGE_PAGE";
    default: return "UNKNOWN";
  }
}
static const char *platform_conditions[] = {"unlinked", "birthBeforePath", "pidpath", "birthAfterPath", "realpath", "pathChanged", "prefix", "csopsUnavailable", "birthBeforeCsops", "csops", "birthAfterCsops", "notPlatform", "stat", "birthAfterStat", "inodeMatch", "regionRejected", "regionUnavailableFirst", "regionPartial", "mainImageMissing"};
static int platform_failure(struct quiescence_counts *counts, int condition) {
  counts->platform_failures[condition]++;
  return 0;
}
static void region_partial_detail(struct quiescence_counts *counts, int error, int regions, int image_seen, int kind, int submap) {
  counts->region_partial++;
  counts->partial_errno = error;
  counts->partial_regions = regions;
  counts->partial_image_seen = image_seen;
  counts->partial_kind = kind;
  counts->partial_submap = submap;
}
static int quiescence_report(const char *call, int error, int birth, struct quiescence_counts *counts) {
  fprintf(stderr, "{\"type\":\"%s\",\"call\":\"%s\",\"errno\":\"%s\",\"errnoNumber\":%d,\"sameBirth\":%d,\"counts\":{\"scanned\":%d,\"skippedGone\":%d,\"skippedUidChanged\":%d,\"skippedFdClosed\":%d,\"matched\":%d,\"failed\":%d,\"exeUnlinkedPreRoot\":%d,\"regionCompared\":%d,\"regionUnavailable\":%d,\"regionPartial\":%d,\"regionZeroSize\":%d,\"sessionLeaderNotUidListed\":%d,\"fdUnobservableSandboxDenied\":%d,\"fdNonGateFailed\":%d,\"fdCleanFailed\":%d,\"fdSandboxFailed\":%d,\"fdDeniedQueries\":%d,\"fdAllowedQueries\":%d,\"fdQueryErrors\":%d,\"fdNotSandboxed\":%d,\"fdUnobservableWriteDenied\":%d,\"fdUnobservablePlatformBinary\":%d,\"notPlatform\":%d,\"pathDisallowed\":%d,\"csopsError\":%d,\"csopsUnavailable\":%d,\"inodeMatch\":%d,\"platformInodeUnobserved\":%d}", counts->failed ? "QuiescenceFailure" : "QuiescenceComplete", call, quiescence_errno(error), error, birth, counts->scanned, counts->skipped_gone, counts->skipped_uid_changed, counts->skipped_fd_closed, counts->matched, counts->failed, counts->exe_unlinked_pre_root, counts->region_compared, counts->region_unavailable, counts->region_partial, counts->region_zero_size, counts->session_leader_not_uid_listed, counts->fd_unobservable, counts->fd_non_gate_failed, counts->fd_clean_failed, counts->fd_sandbox_failed, counts->fd_denied_queries, counts->fd_allowed_queries, counts->fd_query_errors, counts->fd_not_sandboxed, counts->fd_write_denied, counts->fd_platform, counts->platform_not, counts->platform_path_disallowed, counts->platform_csops_error, counts->platform_csops_unavailable, counts->platform_inode_match, counts->platform_inode_unobserved);
  const char *slots[] = {"root:read", "root:write", "probe:read", "probe:write", "src:read", "src:write", "absent:read", "absent:write", "root:create", "root:unlink", "probe:create", "probe:unlink", "src:create", "src:unlink", "absent:create", "absent:unlink"};
  fputs(",\"fdAllowedByQuery\":{", stderr);
  for (int index = 0; index < 16; index++) fprintf(stderr, "%s\"%s\":%d", index ? "," : "", slots[index], counts->fd_allowed_by_query[index]);
  fputs("},\"fdFailedQueryResults\":[", stderr);
  for (int index = 0; index < 16; index++) fprintf(stderr, "%s%d", index ? "," : "", counts->fd_failed_results[index]);
  fputs("],\"fdWriteDeniedReadResults\":{", stderr);
  for (int index = 0; index < 4; index++) fprintf(stderr, "%s\"%s\":{\"allowed\":%d,\"denied\":%d}", index ? "," : "", slots[index * 2], counts->fd_read_allowed[index], counts->fd_read_denied[index]);
  const char *terminations[] = {"none", "read-error", "short-read", "zero-size", "limit", "overflow", "end-not-past-request"};
  fprintf(stderr, "},\"regionPartialDetail\":{\"errno\":\"%s\",\"regionsRead\":%d,\"mainImageSeen\":%d,\"termination\":\"%s\",\"regionKind\":\"%s\",\"lastBeforeEINVAL\":\"%s\"},\"platformFailures\":{", quiescence_errno(counts->partial_errno), counts->partial_regions, counts->partial_image_seen, terminations[counts->partial_kind], counts->partial_submap == 2 ? "submap" : counts->partial_submap == 1 ? "mapping" : "unobserved", counts->partial_kind ? "unknown" : "not-applicable");
  for (int index = 0; index < 19; index++) fprintf(stderr, "%s\"%s\":%d", index ? "," : "", platform_conditions[index], counts->platform_failures[index]);
  fprintf(stderr, "},\"regionZeroSizeDetail\":{\"returnLength\":\"%s\",\"shareMode\":\"%s\",\"regionKind\":\"%s\",\"lastBeforeEINVAL\":\"%s\"}}\n", counts->zero_observed ? "exact" : "unobserved", counts->zero_observed ? quiescence_share_mode(counts->zero_share_mode) : "UNOBSERVED", counts->zero_observed ? counts->zero_submap ? "submap" : "mapping" : "unobserved", !counts->zero_observed ? "not-applicable" : counts->zero_end == 1 ? "yes" : counts->zero_end == 2 ? "no" : "unknown");
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
struct gate_birth { int pid, ppid; unsigned long long sec, usec; };
static struct gate_birth gate_births[1000000];
static int gate_birth_count;
static int gate_own(int pid, struct proc_bsdinfo *birth) {
  for (int index = 0; index < gate_birth_count; index++) if (gate_births[index].pid == pid && gate_births[index].sec == birth->pbi_start_tvsec && gate_births[index].usec == birth->pbi_start_tvusec) return index + 1;
  return 0;
}
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
enum region_state { REGION_REJECTED, REGION_COMPLETE, REGION_UNAVAILABLE_FIRST, REGION_PARTIAL };
static enum region_state region_walk(int pid, struct proc_bsdinfo *birth, int inode_count, struct quiescence_counts *counts, unsigned long long image_dev, unsigned long long image_ino, int *image_seen) {
  unsigned long long address = 0;
  int last_zero = 0, zero_seen = 0;
  for (int index = 0; index < 65536; index++) {
    struct proc_regionwithpathinfo region;
    memset(&region, 0, sizeof(region));
    errno = 0;
    int got = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &region, sizeof(region));
    int error = errno;
    if (same_birth(pid, birth->pbi_start_tvsec, birth->pbi_start_tvusec)) return REGION_REJECTED;
    if (got != (int)sizeof(region) || error) {
      if (!index && !got && error) { counts->region_unavailable++; return REGION_UNAVAILABLE_FIRST; }
      if (!got && error == EINVAL) { if (zero_seen) counts->zero_end = last_zero ? 1 : 2; return REGION_COMPLETE; }
      region_partial_detail(counts, error, index, *image_seen, error ? 1 : 2, 0);
      return REGION_PARTIAL;
    }
    unsigned long long start = region.prp_prinfo.pri_address, size = region.prp_prinfo.pri_size;
    int submap = region.prp_prinfo.pri_flags & PROC_REGION_SUBMAP ? 2 : 1;
    last_zero = !size;
    if (!size) {
      counts->zero_submap = !!(region.prp_prinfo.pri_flags & PROC_REGION_SUBMAP);
      counts->zero_observed = 1;
      zero_seen = 1;
      counts->zero_end = 0;
      counts->zero_share_mode = region.prp_prinfo.pri_share_mode;
      if (start < address) { region_partial_detail(counts, 0, index + 1, *image_seen, 6, submap); return REGION_PARTIAL; }
      if (start == ~0ULL || address == ~0ULL) { region_partial_detail(counts, 0, index + 1, *image_seen, 5, submap); return REGION_PARTIAL; }
      counts->region_zero_size++;
      unsigned long long after_request = address + 1, after_start = start + 1;
      address = after_request > after_start ? after_request : after_start;
      continue;
    }
    unsigned long long dev = (unsigned int)region.prp_vip.vip_vi.vi_stat.vst_dev, ino = region.prp_vip.vip_vi.vi_stat.vst_ino;
    if (ino) {
      counts->region_compared++;
      for (int item = 0; item < inode_count; item++) if (root_inodes[item].dev == dev && root_inodes[item].ino == ino) { counts->platform_inode_match++; return REGION_REJECTED; }
      if (image_ino && dev == image_dev && ino == image_ino) *image_seen = 1;
    }
    if (size > ~0ULL - start || address == ~0ULL) { region_partial_detail(counts, 0, index + 1, *image_seen, 5, submap); return REGION_PARTIAL; }
    unsigned long long end = start + size;
    if (end <= address) { region_partial_detail(counts, 0, index + 1, *image_seen, 6, submap); return REGION_PARTIAL; }
    unsigned long long after_request = address + 1;
    address = end > after_request ? end : after_request;
  }
  region_partial_detail(counts, 0, 65536, *image_seen, 4, 0);
  return REGION_PARTIAL;
}
static int platform_fd_proof(int pid, struct proc_bsdinfo *birth, int unlinked, int inode_count, struct quiescence_counts *counts) {
  char image[PROC_PIDPATHINFO_MAXSIZE], canonical[PATH_MAX];
  if (unlinked) { counts->platform_path_disallowed++; return platform_failure(counts, 0); }
  if (same_birth(pid, birth->pbi_start_tvsec, birth->pbi_start_tvusec)) { counts->platform_path_disallowed++; return platform_failure(counts, 1); }
  errno = 0;
  int got = proc_pidpath(pid, image, sizeof(image));
  if (got <= 0) { counts->platform_path_disallowed++; return platform_failure(counts, 2); }
  if (same_birth(pid, birth->pbi_start_tvsec, birth->pbi_start_tvusec)) { counts->platform_path_disallowed++; return platform_failure(counts, 3); }
  if (!realpath(image, canonical)) { counts->platform_path_disallowed++; return platform_failure(counts, 4); }
  if (strcmp(image, canonical)) { counts->platform_path_disallowed++; return platform_failure(counts, 5); }
  const char *prefixes[] = {"/System/Library/", "/System/Applications/", "/usr/libexec/", "/usr/sbin/"};
  int allowed = 0;
  for (int index = 0; index < 4; index++) if (!strncmp(canonical, prefixes[index], strlen(prefixes[index]))) allowed = 1;
  if (!allowed) { counts->platform_path_disallowed++; return platform_failure(counts, 6); }
  csops_function code_status = csops_checker();
  if (!code_status) { counts->platform_csops_unavailable++; return platform_failure(counts, 7); }
  unsigned int flags = 0;
  if (same_birth(pid, birth->pbi_start_tvsec, birth->pbi_start_tvusec)) { counts->platform_csops_error++; return platform_failure(counts, 8); }
  errno = 0;
  int status = code_status(pid, CS_OPS_STATUS, &flags, sizeof(flags));
  int error = errno;
  if (status || error) { counts->platform_csops_error++; return platform_failure(counts, 9); }
  if (same_birth(pid, birth->pbi_start_tvsec, birth->pbi_start_tvusec)) { counts->platform_csops_error++; return platform_failure(counts, 10); }
  if (!(flags & CS_PLATFORM_BINARY)) { counts->platform_not++; return platform_failure(counts, 11); }
  struct stat file;
  if (stat(canonical, &file)) { counts->platform_inode_unobserved++; return platform_failure(counts, 12); }
  if (same_birth(pid, birth->pbi_start_tvsec, birth->pbi_start_tvusec)) { counts->platform_inode_unobserved++; return platform_failure(counts, 13); }
  unsigned long long dev = (unsigned int)file.st_dev, ino = file.st_ino;
  for (int index = 0; index < inode_count; index++) if (root_inodes[index].dev == dev && root_inodes[index].ino == ino) { counts->platform_inode_match++; return platform_failure(counts, 14); }
  int image_seen = 0;
  enum region_state state = region_walk(pid, birth, inode_count, counts, dev, ino, &image_seen);
  if (state == REGION_COMPLETE && image_seen) return 1;
  counts->platform_inode_unobserved++;
  return platform_failure(counts, state == REGION_REJECTED ? 15 : state == REGION_UNAVAILABLE_FIRST ? 16 : state == REGION_PARTIAL ? 17 : 18);
}
static int quiescence(int controller, const char *root, unsigned long long created, char **denial_paths) {
  struct quiescence_counts counts = {0};
  for (int index = 0; index < 16; index++) counts.fd_failed_results[index] = -2;
  const char *failure_call = "birth";
  int failure_errno = 0, failure_birth = -1;
  int inode_count = 0;
  if (created < 2000000 || scanf("%d", &inode_count) != 1 || inode_count < 0 || inode_count > 1000000) return quiescence_failure("root", EINVAL, -1, &counts);
  for (int index = 0; index < inode_count; index++) if (scanf("%llu %llu", &root_inodes[index].dev, &root_inodes[index].ino) != 2) return quiescence_failure("root", EINVAL, -1, &counts);
  if (scanf("%d", &gate_launch_count) != 1 || gate_launch_count < 0 || gate_launch_count > 1000000) return quiescence_failure("root", EINVAL, -1, &counts);
  for (int index = 0; index < gate_launch_count; index++) if (scanf("%d", &gate_launch_pids[index]) != 1 || gate_launch_pids[index] <= 0) return quiescence_failure("root", EINVAL, -1, &counts);
  if (scanf("%d", &gate_birth_count) != 1 || gate_birth_count < 0 || gate_birth_count > 1000000) return quiescence_failure("root", EINVAL, -1, &counts);
  for (int index = 0; index < gate_birth_count; index++) if (scanf("%d %d %llu %llu", &gate_births[index].pid, &gate_births[index].ppid, &gate_births[index].sec, &gate_births[index].usec) != 4 || gate_births[index].pid <= 0 || gate_births[index].ppid < 0) return quiescence_failure("root", EINVAL, -1, &counts);
  int foreign_counts[3] = {0};
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
    char image[PROC_PIDPATHINFO_MAXSIZE], matched[3][PATH_MAX] = {{0}};
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
        int image_seen = 0;
        enum region_state state = region_walk(pid, &birth, inode_count, &counts, 0, 0, &image_seen);
        if (state != REGION_COMPLETE && state != REGION_UNAVAILABLE_FIRST) { failed = 1; failure_call = "region inode"; failure_errno = ENOENT; failure_birth = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec); continue; }
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
    for (int part = 0; part < 2; part++) if (root_path(names[part], root)) snprintf(matched[part], sizeof(matched[part]), "%s", names[part]);
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
      if (root_path(vnode.pvip.vip_path, root)) snprintf(matched[2], sizeof(matched[2]), "%s", vnode.pvip.vip_path);
    }
    free(fds);
    if (gone || failed) continue;
    status = same_birth(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec);
    if (!status && (matched[0][0] || matched[1][0] || matched[2][0])) {
      counts.matched++;
      const char *categories[] = {"cwd", "exe", "fd"};
      for (int part = 0; part < 3; part++) if (matched[part][0]) {
        int own = gate_own(pid, &birth);
        if (own) printf("OWN\t%d\t%u\t%llu\t%llu\t%s\t%s\n", pid, (unsigned int)gate_births[own - 1].ppid, birth.pbi_start_tvsec, birth.pbi_start_tvusec, categories[part], matched[part][strlen(root)] ? matched[part] + strlen(root) + 1 : ".");
        else foreign_counts[part]++;
      }
    }
    if (status == 4) { failed = 1; failure_call = "birth"; failure_errno = errno; failure_birth = status; }
    else if (status == 3) counts.skipped_gone++;
    else if (!status && fd_unobservable) {
      failure_call = "fdinfo"; failure_errno = EPERM; failure_birth = 0;
      if (!unlinked_session(pid, &birth, controller, pids, got, created, &counts, !unlinked)) { counts.fd_non_gate_failed++; failed = 1; }
      else if ((matched[0][0] || matched[1][0] || matched[2][0]) || (unlinked && !region_proven)) { counts.fd_clean_failed++; failed = 1; }
      else {
        int results[16], allowed_by_query[16] = {0};
        for (int index = 0; index < 16; index++) results[index] = -2;
        int before_not_sandboxed = counts.fd_not_sandboxed;
        int proof = quiescence_sandbox_denied(pid, birth.pbi_start_tvsec, birth.pbi_start_tvusec, denial_paths, &counts.fd_denied_queries, &counts.fd_allowed_queries, &counts.fd_query_errors, &counts.fd_not_sandboxed, allowed_by_query, results);
        if (!proof && counts.fd_not_sandboxed > before_not_sandboxed && platform_fd_proof(pid, &birth, unlinked, inode_count, &counts)) proof = 3;
        if (!proof) { counts.fd_sandbox_failed++; failed = 1; memcpy(counts.fd_failed_results, results, sizeof(results)); for (int index = 0; index < 16; index++) counts.fd_allowed_by_query[index] += allowed_by_query[index]; }
        else {
          if (proof == 1) counts.fd_unobservable++;
          else if (proof == 3) counts.fd_platform++;
          else { counts.fd_write_denied++; for (int index = 0; index < 4; index++) { if (results[index * 2]) counts.fd_read_denied[index]++; else counts.fd_read_allowed[index]++; } }
          if (unlinked) counts.exe_unlinked_pre_root++;
        }
      }
    }
    else if (!status && (matched[0][0] || matched[1][0] || matched[2][0])) {
      if (unlinked) { failed = 1; failure_call = "unlinked policy"; failure_errno = ENOENT; failure_birth = 0; }
    } else if (!status && unlinked) {
      if (!unlinked_session(pid, &birth, controller, pids, got, created, &counts, 0)) { failed = 1; failure_call = "unlinked policy"; failure_errno = ENOENT; failure_birth = 0; }
      else counts.exe_unlinked_pre_root++;
    }
  }
  free(pids);
  const char *categories[] = {"cwd", "exe", "fd"};
  for (int part = 0; part < 3; part++) if (foreign_counts[part]) printf("FOREIGN\t%s\t%d\n", categories[part], foreign_counts[part]);
  if (failed) return quiescence_failure(failure_call, failure_errno, failure_birth, &counts);
  quiescence_report("none", 0, -1, &counts);
  puts("COMPLETE");
  return 0;
}

