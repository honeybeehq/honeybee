import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import {
  captureGitRusage, readGitRusageRecords, setupGitRusage,
} from './git-rusage.mjs';

const CONFIG_ENV = 'HONEYBEE_GIT_RUSAGE_CONFIG';
const CF_ENV = '__CF_USER_TEXT_ENCODING';
const STATE_ENV = 'HONEYBEE_GIT_RUSAGE_NATIVE_STATE';
const TEST_PYTHON_ENV = 'HONEYBEE_TEST_GIT_RUSAGE_PYTHON';
const STDIN = Buffer.from('native-stdin:\0line two\n', 'utf8');
const STDOUT = Buffer.from('native-stdout:\x01\n', 'utf8');
const STDERR = Buffer.from('native-stderr:\x02\n', 'utf8');

const NATIVE_FIXTURE = String.raw`
#define _DARWIN_C_SOURCE 1

#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

struct child_usage {
  long long cpu_micros;
  long long max_rss_bytes;
};

static void fail(const char *message) {
  perror(message);
  _exit(120);
}

static void write_all(int fd, const unsigned char *bytes, size_t length) {
  while (length > 0) {
    ssize_t written = write(fd, bytes, length);
    if (written < 0) {
      if (errno == EINTR) continue;
      fail("write");
    }
    bytes += (size_t)written;
    length -= (size_t)written;
  }
}

static unsigned char *read_stdin(size_t *length) {
  size_t used = 0;
  size_t capacity = 256;
  unsigned char *bytes = malloc(capacity);
  if (bytes == NULL) fail("malloc stdin");
  for (;;) {
    if (used == capacity) {
      capacity *= 2;
      unsigned char *expanded = realloc(bytes, capacity);
      if (expanded == NULL) fail("realloc stdin");
      bytes = expanded;
    }
    ssize_t count = read(STDIN_FILENO, bytes + used, capacity - used);
    if (count < 0) {
      if (errno == EINTR) continue;
      fail("read stdin");
    }
    if (count == 0) break;
    used += (size_t)count;
  }
  *length = used;
  return bytes;
}

static void write_hex(FILE *file, const unsigned char *bytes, size_t length) {
  static const char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < length; index += 1) {
    unsigned char value = bytes[index];
    fputc(digits[value >> 4], file);
    fputc(digits[value & 15], file);
  }
}

static void write_field(FILE *file, const char *name, const unsigned char *bytes,
                        size_t length) {
  fprintf(file, "%s\t", name);
  write_hex(file, bytes, length);
  fputc('\n', file);
}

static int compare_strings(const void *left, const void *right) {
  const char *const *left_string = left;
  const char *const *right_string = right;
  return strcmp(*left_string, *right_string);
}

static void write_state(const char *path, int argc, char **argv,
                        const unsigned char *stdin_bytes, size_t stdin_length,
                        const struct child_usage *children, size_t child_count) {
  FILE *file = fopen(path, "w");
  if (file == NULL) fail("fopen state");

  char *cwd = getcwd(NULL, 0);
  if (cwd == NULL) fail("getcwd");
  write_field(file, "cwd", (const unsigned char *)cwd, strlen(cwd));
  free(cwd);
  fprintf(file, "pid\t%ld\n", (long)getpid());
  write_field(file, "stdin", stdin_bytes, stdin_length);
  for (int index = 0; index < argc; index += 1) {
    write_field(file, "argv", (const unsigned char *)argv[index], strlen(argv[index]));
  }

  size_t environment_count = 0;
  while (environ[environment_count] != NULL) environment_count += 1;
  char **environment = malloc(environment_count * sizeof(*environment));
  if (environment == NULL && environment_count > 0) fail("malloc environment");
  for (size_t index = 0; index < environment_count; index += 1) {
    environment[index] = environ[index];
  }
  qsort(environment, environment_count, sizeof(*environment), compare_strings);
  for (size_t index = 0; index < environment_count; index += 1) {
    write_field(file, "env", (const unsigned char *)environment[index],
                strlen(environment[index]));
  }
  free(environment);

  for (size_t index = 0; index < child_count; index += 1) {
    fprintf(file, "child\t%lld\t%lld\n", children[index].cpu_micros,
            children[index].max_rss_bytes);
  }
  if (fclose(file) != 0) fail("fclose state");
}

static long long timeval_micros(struct timeval value) {
  return (long long)value.tv_sec * 1000000LL + (long long)value.tv_usec;
}

static long long process_cpu_nanos(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &value) != 0) fail("clock_gettime");
  return (long long)value.tv_sec * 1000000000LL + (long long)value.tv_nsec;
}

static void grandchild_work(size_t resident_bytes) {
  volatile unsigned char *resident = malloc(resident_bytes);
  if (resident == NULL) fail("malloc resident");
  long page_size = sysconf(_SC_PAGESIZE);
  if (page_size <= 0) fail("sysconf pagesize");
  for (size_t offset = 0; offset < resident_bytes; offset += (size_t)page_size) {
    resident[offset] = (unsigned char)(offset / (size_t)page_size);
  }

  const long long target_cpu_nanos = 15000000LL;
  const long long started = process_cpu_nanos();
  volatile uint64_t accumulator = 0x9e3779b97f4a7c15ULL;
  do {
    for (unsigned int index = 0; index < 100000; index += 1) {
      accumulator ^= accumulator << 7;
      accumulator ^= accumulator >> 9;
      accumulator += (uint64_t)index;
    }
  } while (process_cpu_nanos() - started < target_cpu_nanos);

  if (resident[0] == 255 && accumulator == 0) _exit(121);
  _exit(0);
}

static struct child_usage run_grandchild(size_t resident_bytes) {
  pid_t child = fork();
  if (child < 0) fail("fork");
  if (child == 0) grandchild_work(resident_bytes);

  int status = 0;
  struct rusage usage;
  pid_t waited;
  do {
    waited = wait4(child, &status, 0, &usage);
  } while (waited < 0 && errno == EINTR);
  if (waited != child) fail("wait4");
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) _exit(122);
  struct child_usage result = {
    .cpu_micros = timeval_micros(usage.ru_utime) + timeval_micros(usage.ru_stime),
    .max_rss_bytes = (long long)usage.ru_maxrss,
  };
  return result;
}

int main(int argc, char **argv) {
  if (argc < 2) return 119;
  const char *state_path = getenv("HONEYBEE_GIT_RUSAGE_NATIVE_STATE");
  if (state_path == NULL || state_path[0] != '/') return 118;
  size_t stdin_length = 0;
  unsigned char *stdin_bytes = read_stdin(&stdin_length);

  struct child_usage children[2];
  size_t child_count = 0;
  if (strcmp(argv[1], "tree") == 0) {
    children[0] = run_grandchild(20U * 1024U * 1024U);
    children[1] = run_grandchild(28U * 1024U * 1024U);
    child_count = 2;
  }

  write_state(state_path, argc, argv, stdin_bytes, stdin_length, children, child_count);
  free(stdin_bytes);
  write_all(STDOUT_FILENO, (const unsigned char *)"native-stdout:\001\n", 16);
  write_all(STDERR_FILENO, (const unsigned char *)"native-stderr:\002\n", 16);
  if (strcmp(argv[1], "signal") == 0) {
    raise(SIGTERM);
    _exit(117);
  }
  return 23;
}
`;

function withEnvironment(updates, operation) {
  const prior = Object.fromEntries(Object.keys(updates).map(key => [key, {
    present: Object.hasOwn(process.env, key), value: process.env[key],
  }]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return operation();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value.present) process.env[key] = value.value;
      else delete process.env[key];
    }
  }
}

function parseState(path) {
  const result = { argvHex: [], childUsage: [], envHex: [] };
  for (const line of readFileSync(path, 'utf8').trimEnd().split('\n')) {
    const [field, ...values] = line.split('\t');
    if (field === 'argv') result.argvHex.push(values[0]);
    else if (field === 'child') {
      result.childUsage.push({ cpuMicros: Number(values[0]), maxRssBytes: Number(values[1]) });
    } else if (field === 'cwd') result.cwdHex = values[0];
    else if (field === 'env') result.envHex.push(values[0]);
    else if (field === 'pid') result.pid = Number(values[0]);
    else if (field === 'stdin') result.stdinHex = values[0];
    else assert.fail(`unknown native fixture state field: ${field}`);
  }
  return result;
}

const decodeHex = value => Buffer.from(value, 'hex').toString('utf8');

function environmentMap(state) {
  return new Map(state.envHex.map(value => {
    const entry = decodeHex(value);
    const separator = entry.indexOf('=');
    assert.ok(separator > 0, `malformed native environment entry: ${entry}`);
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function assertProcessOutcome(actual, expected) {
  assert.equal(actual.error, undefined);
  assert.equal(actual.status, expected.status);
  assert.equal(actual.signal, expected.signal);
  assert.deepEqual(actual.stdout, STDOUT);
  assert.deepEqual(actual.stderr, STDERR);
}

function defaultDirectPython() {
  const probe = spawnSync('/usr/bin/python3', [
    '-c', 'import sys; print(sys.executable)',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(probe.status, 0, `default Python probe failed:\n${probe.stderr}`);
  const executable = probe.stdout.trim();
  assert.equal(isAbsolute(executable), true, 'default Python reported a non-absolute executable');
  return executable;
}

function runNativePair({ args, caseDir, expected, fixture, session }) {
  const statePath = join(caseDir, 'native-state.txt');
  const cwd = join(caseDir, 'cwd');
  mkdirSync(cwd, { mode: 0o700 });
  return withEnvironment({ [STATE_ENV]: statePath }, () => {
    const options = { argv0: 'git', cwd, env: process.env, input: STDIN, timeout: 30_000 };
    const direct = spawnSync(fixture, args, options);
    assertProcessOutcome(direct, expected);
    const directState = parseState(statePath);
    rmSync(statePath);

    const capture = captureGitRusage(session, {
      id: args[0],
      operation: () => spawnSync('git', args, {
        cwd, env: process.env, input: STDIN, timeout: 30_000,
      }),
      retainedDir: join(caseDir, 'retained-records'),
    });
    assert.equal(capture.failed, false);
    assert.equal(capture.error, null);
    assertProcessOutcome(capture.value, expected);
    const shimState = parseState(statePath);
    const records = readGitRusageRecords(capture.recordsDir, capture.runId);
    assert.equal(records.length, 1);
    const record = records[0];

    assert.deepEqual(shimState.argvHex, directState.argvHex, 'argv bytes changed through shim');
    assert.deepEqual(shimState.envHex, directState.envHex, 'full environment changed through shim');
    assert.equal(shimState.cwdHex, directState.cwdHex, 'cwd bytes changed through shim');
    assert.equal(shimState.stdinHex, directState.stdinHex, 'stdin bytes changed through shim');
    assert.deepEqual(shimState.argvHex.map(decodeHex), ['git', ...args]);
    const observedCwd = decodeHex(shimState.cwdHex);
    assert.equal(observedCwd, decodeHex(directState.cwdHex));
    assert.deepEqual(Buffer.from(shimState.stdinHex, 'hex'), STDIN);
    assert.equal(record.realGitPid, shimState.pid);
    assert.equal(record.wrapperPid, capture.value.pid);
    assert.equal(record.launcherPid, process.pid);
    assert.deepEqual(record.argv, ['git', ...args]);
    assert.equal(record.cwd, observedCwd);
    assert.equal(record.returncode, expected.recordReturncode);
    assert.equal(record.terminatedBySignal, expected.terminatedBySignal);
    assert.equal(capture.rawArtifact.files.length, 1);
    assert.equal(capture.rawArtifact.files[0].mode, 0o600);
    return { directState, record, shimState };
  });
}

function withSession({ cfValue, fixture, label, pythonExecutable, root }, operation) {
  const runDir = join(root, `run-${label}`);
  mkdirSync(runDir, { mode: 0o700 });
  const originalPath = process.env.PATH;
  assert.equal(typeof originalPath, 'string', 'native Git rusage test requires PATH');
  return withEnvironment({
    [CF_ENV]: cfValue,
    HONEYBEE_GIT_RUSAGE_NATIVE_EMPTY: '',
    HONEYBEE_GIT_RUSAGE_NATIVE_MARKER: 'space = value\nsecond line',
    LC_CTYPE: 'C.UTF-8',
    PATH: `${join(root, 'fixture')}${delimiter}${originalPath}`,
  }, () => {
    const session = setupGitRusage({ runDir, pythonExecutable });
    assert.equal(session.realGitPath, fixture);
    return operation(session);
  });
}

test('materialized macOS shim preserves process semantics and includes waited descendants', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  assert.equal(process.env[CONFIG_ENV], undefined, `unset inherited ${CONFIG_ENV}`);
  assert.equal(process.env.GIT_TRACE2_EVENT, undefined, 'unset inherited GIT_TRACE2_EVENT');
  const pythonExecutable = process.env[TEST_PYTHON_ENV] ?? defaultDirectPython();
  assert.equal(isAbsolute(pythonExecutable), true,
    `${TEST_PYTHON_ENV} must name an absolute Python 3.9+ executable`);

  const root = mkdtempSync(join(tmpdir(), 'hb-git-rusage-native-test-'));
  chmodSync(root, 0o700);
  try {
    const fixtureDir = join(root, 'fixture');
    mkdirSync(fixtureDir, { mode: 0o700 });
    const source = join(fixtureDir, 'git-fixture.c');
    const fixture = join(fixtureDir, 'git');
    writeFileSync(source, NATIVE_FIXTURE, { mode: 0o600 });
    const compile = spawnSync('/usr/bin/cc', [
      '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', fixture,
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(compile.status, 0, `native fixture compilation failed:\n${compile.stderr}`);
    chmodSync(fixture, 0o700);

    withSession({
      cfValue: '0x1F5:0x0:0x0', fixture, label: 'cf-present', pythonExecutable, root,
    }, session => {
      const normalDir = join(root, 'normal');
      mkdirSync(normalDir, { mode: 0o700 });
      const normal = runNativePair({
        args: ['normal', 'argument with spaces', '', '--literal=$value'],
        caseDir: normalDir,
        expected: { recordReturncode: 23, signal: null, status: 23, terminatedBySignal: null },
        fixture,
        session,
      });
      const normalEnvironment = environmentMap(normal.shimState);
      assert.equal(normalEnvironment.get('PATH'), session.environment.path);
      assert.equal(normalEnvironment.get(CF_ENV), '0x1F5:0x0:0x0');
      assert.equal(normalEnvironment.has(CONFIG_ENV), false);
      assert.equal(normalEnvironment.get('HONEYBEE_GIT_RUSAGE_NATIVE_EMPTY'), '');
      assert.equal(normalEnvironment.get('HONEYBEE_GIT_RUSAGE_NATIVE_MARKER'),
        'space = value\nsecond line');

      const treeDir = join(root, 'tree');
      mkdirSync(treeDir, { mode: 0o700 });
      const tree = runNativePair({
        args: ['tree'],
        caseDir: treeDir,
        expected: { recordReturncode: 23, signal: null, status: 23, terminatedBySignal: null },
        fixture,
        session,
      });
      assert.equal(tree.shimState.childUsage.length, 2);
      const childCpuMicros = tree.shimState.childUsage.reduce(
        (total, child) => total + child.cpuMicros, 0,
      );
      const childRss = tree.shimState.childUsage.map(child => child.maxRssBytes);
      assert.ok(childCpuMicros >= 20_000, 'native grandchildren did not perform process-CPU work');
      assert.ok(tree.record.cpuMicros + 4 >= childCpuMicros,
        'RUSAGE_CHILDREN omitted CPU from a waited grandchild');
      assert.ok(childRss.every(value => value > 0), 'native grandchild RSS was not observed');
      assert.ok(tree.record.maxRssBytes >= Math.max(...childRss),
        'RUSAGE_CHILDREN maximum omitted a waited grandchild RSS peak');
      assert.ok(tree.record.maxRssBytes < childRss.reduce((total, value) => total + value, 0),
        'max RSS was summed across sequential grandchildren');
      assert.equal(tree.record.rusageChildrenBefore.maxRssBytes, 0);
      assert.equal(tree.record.rusageChildrenAfter.maxRssBytes, tree.record.maxRssBytes);
      assert.equal(tree.record.maxRssAttributable, true);
    });

    withSession({
      cfValue: undefined, fixture, label: 'cf-absent', pythonExecutable, root,
    }, session => {
      const signalDir = join(root, 'signal');
      mkdirSync(signalDir, { mode: 0o700 });
      const signal = runNativePair({
        args: ['signal'],
        caseDir: signalDir,
        expected: { recordReturncode: -15, signal: 'SIGTERM', status: null, terminatedBySignal: 15 },
        fixture,
        session,
      });
      const signalEnvironment = environmentMap(signal.shimState);
      assert.equal(signalEnvironment.get('PATH'), session.environment.path);
      assert.equal(signalEnvironment.has(CF_ENV), false);
      assert.equal(signalEnvironment.has(CONFIG_ENV), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
