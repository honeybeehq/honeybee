import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeSecret } from "../src/championHomes.ts";

test("champion-secrets: the name-only scan flags credential-like paths and leaves ordinary memory alone", () => {
  for (const path of [".env", ".env.local", ".envrc", "deploy.pem", "id_rsa", ".ssh/known_hosts", ".aws/credentials", ".kube/config", "ops/kubeconfig", "ops/prod.kubeconfig", "gcp/service-account-prod.json", "gcp/serviceAccount.json", "keys/app.key.json", ".terraform/terraform.tfstate", "infra/prod.tfvars", ".config/hive/token", ".config/gcloud/credentials.db", ".claude/.credentials.json", ".codex/auth.json", ".npmrc", "vendor/.git-credentials", "secrets.json"]) {
    assert.equal(looksLikeSecret(path), true, path);
  }
  for (const path of ["MEMORY.md", "memory/lab.md", "notes/keynote.md", "src/keyboard.ts", "docs/tokens-design.md", ".claude/settings.json", "config/app.json", "env.example.md"]) {
    assert.equal(looksLikeSecret(path), false, path);
  }
});
