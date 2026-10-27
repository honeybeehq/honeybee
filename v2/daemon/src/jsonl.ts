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
