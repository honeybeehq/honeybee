import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

/** Admission-only executables: tests intercept launch, so execution must fail. */
export async function fixtureExecutablePath(root: string, names: string[]): Promise<string> {
  const bin = join(root, "fixture-bin");
  await mkdir(bin, { recursive: true });
  for (const name of names) {
    await writeFile(join(bin, name), "#!/bin/sh\necho 'admission fixture must not execute' >&2\nexit 97\n", { mode: 0o755 });
  }
  return [bin, process.env.PATH ?? ""].join(delimiter);
}
