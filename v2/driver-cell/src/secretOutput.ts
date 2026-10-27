export class SecretOutput {
  private pending = Buffer.alloc(0);
  private readonly values: Buffer[];
  private readonly overlap: number;
  private readonly firstByte = new Map<number, Buffer[]>();
  private readonly capture: (chunk: Buffer) => void;
  constructor(values: readonly string[], capture: (chunk: Buffer) => void) {
    this.capture = capture;
    this.values = [...new Set(values)].map(value => Buffer.from(value)).filter(value => value.length > 0).sort((a, b) => b.length - a.length);
    this.overlap = Math.max(0, ...this.values.map(value => value.length - 1));
    for (const value of this.values) {
      const candidates = this.firstByte.get(value[0]!) ?? [];
      candidates.push(value);
      this.firstByte.set(value[0]!, candidates);
    }
  }
  push(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    this.drain(false);
  }
  finish(normal = true): void {
    if (normal) this.drain(true);
    else {
      this.pending.fill(0);
      this.pending = Buffer.alloc(0);
    }
  }
  private drain(final: boolean): void {
    const limit = final ? this.pending.length : Math.max(0, this.pending.length - this.overlap);
    let cursor = 0;
    let plain = 0;
    while (cursor < limit) {
      const remaining = this.pending.length - cursor;
      const value = this.firstByte.get(this.pending[cursor]!)?.find(value => {
        const length = Math.min(value.length, remaining);
        return (final || length === value.length) && this.pending.compare(value, 0, length, cursor, cursor + length) === 0;
      });
      if (value) {
        if (cursor > plain) this.capture(this.pending.subarray(plain, cursor));
        this.capture(Buffer.from("[REDACTED]"));
        cursor += Math.min(value.length, remaining);
        plain = cursor;
      } else cursor++;
    }
    if (cursor > plain) this.capture(this.pending.subarray(plain, cursor));
    const tail = Buffer.from(this.pending.subarray(cursor));
    this.pending.fill(0);
    this.pending = tail;
  }
  dispose(): void {
    this.pending.fill(0);
    this.pending = Buffer.alloc(0);
    for (const value of this.values) value.fill(0);
  }
}

export function validateSecretEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("secret_execution_invalid");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 32) throw new Error("secret_execution_invalid");
  let size = 0;
  for (const [name, material] of entries) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) || /^(?:LD_|DYLD_|HIVE_|GIT_|npm_)/i.test(name)
      || /^(?:PATH|HOME|TMPDIR|TMP|TEMP|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|IFS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|ZDOTDIR|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|CLASSPATH|GCONV_PATH|GLIBC_TUNABLES|LOCPATH|NLSPATH|PROMPT_COMMAND|PS4|OPENSSL_CONF|OPENSSL_MODULES)$/i.test(name)
      || typeof material !== "string" || material.length === 0 || material.includes("\0") || Buffer.byteLength(material) > 16384) throw new Error("secret_execution_invalid");
    size += Buffer.byteLength(material);
  }
  if (size > 65536) throw new Error("secret_execution_invalid");
  return Object.fromEntries(entries) as Record<string, string>;
}
