import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("release: the Codex CLI the writer-lock gate runs is pinned in one file, and the docs say how to raise it", () => {
  const pinned = read(".github/codex-cli-version");
  assert.match(pinned, /^\d+\.\d+\.\d+\n$/, "one exact version, no range or tag");
  const workflow = read(".github/workflows/release.yml");
  assert.doesNotMatch(workflow, /@openai\/codex@latest/);
  assert.match(workflow, /npm install --global "@openai\/codex@\$\(cat \.github\/codex-cli-version\)"/);
  assert.match(workflow, /test "\$\(codex --version\)" = "codex-cli \$\(cat \.github\/codex-cli-version\)"/);
  const docs = read("docs/honeybee-releases.md");
  assert.match(docs, /\.github\/codex-cli-version/);
  assert.match(docs, /CODEX_BIN=.* npm run v2:codex:writer-lock/);
});
