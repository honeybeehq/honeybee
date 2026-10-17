#include <stddef.h>
#include <string.h>

struct argv_span { size_t start; size_t size; };
static int parse_argv_only(const unsigned char *buffer, size_t size, struct argv_span *arguments, size_t capacity, size_t *count) {
  int argc = 0;
  *count = 0;
  if (size < sizeof(argc)) return 0;
  memcpy(&argc, buffer, sizeof(argc));
  if (argc <= 0 || (size_t)argc > capacity) return 0;
  size_t position = sizeof(argc);
  while (position < size && buffer[position]) position++;
  if (position == size) return 0;
  while (position < size && !buffer[position]) position++;
  for (int index = 0; index < argc; index++) {
    size_t start = position;
    while (position < size && buffer[position]) position++;
    if (position == size) return 0;
    arguments[index].start = start;
    arguments[index].size = position - start;
    position++;
  }
  *count = (size_t)argc;
  return 1;
}

static inline int reader_argv_exact(const unsigned char *buffer, const struct argv_span *args, size_t count, const char *node, const char *reader, const char *preloader) {
  if (strcmp((const char *)buffer + args[0].start, node)) return 0;
  if (!strcmp(preloader, "-")) return count == 2 && !strcmp((const char *)buffer + args[1].start, reader);
  return count == 4 && !strcmp((const char *)buffer + args[1].start, "--import") && !strcmp((const char *)buffer + args[2].start, preloader) && !strcmp((const char *)buffer + args[3].start, reader);
}
