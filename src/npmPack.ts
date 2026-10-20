type PackFile = { path: string };
export type NpmPackResult = { name: string; filename: string; files: PackFile[] };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && !/[\\\x00-\x1f\x7f]/u.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function parseNpmPackResult(output: string, expectedName: string): NpmPackResult {
  const parsed: unknown = JSON.parse(output);
  let packed: unknown;
  if (Array.isArray(parsed) && parsed.length === 1) {
    packed = parsed[0];
  } else if (record(parsed) && Object.keys(parsed).length === 1 && Object.hasOwn(parsed, expectedName)) {
    packed = parsed[expectedName];
  } else {
    throw new Error("npm pack returned an unsupported result shape");
  }
  if (!record(packed) || packed.name !== expectedName
    || typeof packed.version !== "string" || packed.version.length === 0
    || !safePath(packed.filename) || packed.filename.includes("/") || !packed.filename.endsWith(".tgz")
    || packed.filename !== `${expectedName.replace("@", "").replace("/", "-")}-${packed.version}.tgz`
    || !Array.isArray(packed.files) || packed.files.length === 0) {
    throw new Error("npm pack returned an invalid package record");
  }
  const seen = new Set<string>();
  const files = packed.files.map((entry: unknown) => {
    if (!record(entry) || !safePath(entry.path) || seen.has(entry.path)) {
      throw new Error("npm pack returned an invalid file record");
    }
    seen.add(entry.path);
    return { path: entry.path };
  });
  return { name: expectedName, filename: packed.filename, files };
}
