#include <stdio.h>
#include <string.h>
#include <ctype.h>

struct node_default_flag { const char *name; const char *value; };
static const struct node_default_flag node_default_flags[] = {
  {"--cpu-prof-interval", "1000"},
  {"--heap-prof-interval", "524288"},
  {"--heapsnapshot-near-heap-limit", "0"},
  {"--inspect-port", "127.0.0.1:9229"},
  {"--inspect-publish-uid", "stderr,http"},
  {"--max-http-header-size", "16384"},
  {"--network-family-autoselection-attempt-timeout", "250"},
  {"--node-snapshot", NULL},
  {"--report-signal", "SIGUSR2"},
  {"--secure-heap", "0"},
  {"--secure-heap-min", "2"},
  {"--stack-trace-limit", "10"},
  {"--test", NULL},
  {"--test-concurrency", "1"},
  {"--test-coverage-branches", "0"},
  {"--test-coverage-functions", "0"},
  {"--test-coverage-lines", "0"},
  {"--test-isolation", "process"},
  {"--test-reporter", "tap"},
  {"--test-timeout", "0"},
  {"--tls-cipher-list", "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA"},
  {"--trace-event-file-pattern", "node_trace.${rotation}.log"},
  {"--use-largepages", "off"},
  {"--v8-pool-size", "4"},
  {"--watch-kill-signal", "SIGTERM"},
};
static const char *node_test_patterns[] = {
  "^(?:Darwin\\ OS\\-level\\ file\\ read\\ outside\\ cwd:\\ cell\\-sandbox;\\ tool\\-policy\\ read\\ UNVERIFIED\\ \\(OS\\-level\\ only\\))$",
  "^(?:Darwin\\\\ OS\\\\-level\\\\ file\\\\ read\\\\ outside\\\\ cwd:\\\\ cell\\\\-sandbox;\\\\ tool\\\\-policy\\\\ read\\\\ UNVERIFIED\\\\ \\\\(OS\\\\-level\\\\ only\\\\))$",
  "^(?:Darwin\\ OS\\-level\\ file\\ read\\ outside\\ cwd:\\ satellite\\-default;\\ tool\\-policy\\ read\\ UNVERIFIED\\ \\(OS\\-level\\ only\\))$",
  "^(?:Darwin\\\\ OS\\\\-level\\\\ file\\\\ read\\\\ outside\\\\ cwd:\\\\ satellite\\\\-default;\\\\ tool\\\\-policy\\\\ read\\\\ UNVERIFIED\\\\ \\\\(OS\\\\-level\\\\ only\\\\))$",
};
static inline void node_flag_name(const char *flag, char name[96]) {
  size_t n = strcspn(flag, "=");
  if (n < 3 || n > 94 || strncmp(flag, "--", 2)) { strcpy(name, "invalid_name"); return; }
  for (size_t i = 2; i < n; i++) if (!(flag[i] >= 'a' && flag[i] <= 'z') && !(flag[i] >= '0' && flag[i] <= '9') && flag[i] != '-') { strcpy(name, "invalid_name"); return; }
  memcpy(name, flag, n); name[n] = 0;
}
static inline int node_default_flag_valid(const char *flag, const char *preloader) {
  char name[96]; node_flag_name(flag, name);
  const char *equals = strchr(flag, '=');
  const char *value = equals ? equals + 1 : NULL;
  if (!strcmp(name, "--test-isolation") && value && !strcmp(value, "none")) return strcmp(preloader, "-") != 0;
  if (!strcmp(name, "--test-name-pattern") && value) {
    for (size_t i = 0; i < sizeof(node_test_patterns) / sizeof(node_test_patterns[0]); i++) if (!strcmp(value, node_test_patterns[i])) return 1;
    return 0;
  }
  for (size_t i = 0; i < sizeof(node_default_flags) / sizeof(node_default_flags[0]); i++) {
    const struct node_default_flag *rule = &node_default_flags[i];
    if (!strcmp(name, rule->name)) return rule->value ? value && !strcmp(value, rule->value) : value == NULL;
  }
  return 0;
}
static inline int node_flags_entry(const unsigned char *buffer, const struct argv_span *args, size_t count, const char *preloader, size_t *entry, char bad[96]) {
  size_t index = 1;
  int imported = 0;
  while (index < count && buffer[args[index].start] == '-') {
    const char *flag = (const char *)buffer + args[index].start;
    node_flag_name(flag, bad);
    if (!strcmp(flag, "--import")) {
      if (imported || !strcmp(preloader, "-") || index + 1 >= count || strcmp((const char *)buffer + args[index + 1].start, preloader)) return 0;
      imported = 1; index += 2; continue;
    }
    if (strcmp(flag, "--experimental-strip-types") && !node_default_flag_valid(flag, preloader)) return 0;
    index++;
  }
  *entry = index;
  return index < count;
}
static inline void print_node_flags(FILE *stream, const unsigned char *buffer, const struct argv_span *args, size_t count, size_t entry, const char *preloader, int valid) {
  for (size_t index = 1; index < count && index < entry; index++) {
    const char *flag = (const char *)buffer + args[index].start;
    if (flag[0] != '-') break;
    char name[96]; node_flag_name(flag, name);
    if (valid && !strcmp(flag, "--experimental-strip-types")) { fprintf(stream, "FLAG --experimental-strip-types reviewed-host-role\n"); continue; }
    if (!strcmp(flag, "--import")) { fprintf(stream, "FLAG %s pinned-preloader\n", name); index++; continue; }
    const char *equals = strchr(flag, '=');
    const char *value = equals ? equals + 1 : "true";
    if (!strcmp(name, "--test-name-pattern")) value = "reviewed-row-pattern";
    if (valid && node_default_flag_valid(flag, preloader)) fprintf(stream, "FLAG %s %s\n", name, value);
    else fprintf(stream, "FLAG_NAME %s\n", name);
  }
}

static inline int node_role_argv(const unsigned char *buffer, const struct argv_span *args, size_t count, size_t entry, const char *node, const char *reader, const char *preloader, const char *test, const char *host, const char *resolved, char bad[96]) {
  if (!strcmp(resolved, reader)) return reader_argv_exact(buffer, args, count, node, reader, preloader);
  if (host && !strcmp(resolved, host)) {
    size_t flag = 1;
    if (flag < entry && !strcmp((const char *)buffer + args[flag].start, "--import")) flag += 2;
    return flag + 1 == entry && !strcmp((const char *)buffer + args[flag].start, "--experimental-strip-types") && count == entry + 2 && buffer[args[entry + 1].start] == '/';
  }
  if (!test || strcmp(resolved, test) || count != entry + 1) return 0;
  for (size_t index = 1; index < entry; index++) {
    const char *value = (const char *)buffer + args[index].start;
    if (!strcmp(value, "--import")) { index++; continue; }
    if (!node_default_flag_valid(value, preloader)) { node_flag_name(value, bad); return 0; }
  }
  return 1;
}
