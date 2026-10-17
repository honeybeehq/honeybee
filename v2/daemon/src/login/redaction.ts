export class LoginRedactor {
  private readonly values = new Set<string>();

  add(values: Readonly<Record<string, string>>): void {
    for (const [field, raw] of Object.entries(values)) {
      for (const value of [raw, raw.trim(), ...(field === "code" ? raw.trim().split("#") : [])]) {
        if (!value) continue;
        const safeUnicode = Buffer.from(value).toString("utf8");
        const variants = [value, encodeURI(safeUnicode), encodeURIComponent(safeUnicode), new URLSearchParams({ v: value }).toString().slice(2), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")];
        try {
          variants.push(new URL(value).toString());
        } catch {}
        for (const variant of variants) {
          this.values.add(variant);
          this.values.add(variant.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()));
        }
      }
    }
  }

  redact(text: string): string {
    const values = [...this.values].sort((a, b) => b.length - a.length);
    let result = text.replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase()).replace(/https?:[^\s<>"']+/gi, () => "[redacted URL]");
    for (const value of values) result = result.split(value.replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase())).join("[redacted]");
    return result.replace(/[A-Za-z0-9_\-]{32,}/g, "…");
  }
}
