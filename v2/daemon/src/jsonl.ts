export class JsonLineBuffer {
  private fragments: string[] = [];

  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline < 0) break;
      const part = chunk.slice(start, newline);
      if (this.fragments.length === 0) {
        lines.push(part);
      } else {
        this.fragments.push(part);
        lines.push(this.fragments.join(""));
        this.fragments = [];
      }
      start = newline + 1;
    }
    if (start < chunk.length) this.fragments.push(chunk.slice(start));
    return lines;
  }
}

const JSON_CHUNK_CHARS = 256 * 1024;

export function jsonChunks(value: unknown): Buffer[] {
  const chunks: Buffer[] = [];
  let parts: string[] = [];
  let size = 0;
  const push = (text: string): void => {
    parts.push(text);
    size += text.length;
    if (size >= JSON_CHUNK_CHARS) flush();
  };
  const flush = (): void => {
    if (size === 0) return;
    chunks.push(Buffer.from(parts.join(""), "utf8"));
    parts = [];
    size = 0;
  };
  const emit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      push("[");
      for (let i = 0; i < entry.length; i += 1) {
        if (i > 0) push(",");
        push(JSON.stringify(entry[i]) ?? "null");
      }
      push("]");
      return;
    }
    if (entry !== null && typeof entry === "object") {
      push("{");
      let first = true;
      for (const [key, item] of Object.entries(entry)) {
        const text = Array.isArray(item) ? null : JSON.stringify(item);
        if (text === undefined) continue;
        push(`${first ? "" : ","}${JSON.stringify(key)}:`);
        first = false;
        if (text === null) emit(item);
        else push(text);
      }
      push("}");
      return;
    }
    push(JSON.stringify(entry) ?? "null");
  };
  emit(value);
  flush();
  return chunks;
}
