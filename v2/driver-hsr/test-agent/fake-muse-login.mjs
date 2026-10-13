#!/usr/bin/env node
/**
 * Fake `muse` for the Muse login-flow tests: `muse login` (or no args, as
 * the node's `agents.muse.login` override runs it) prints the device
 * sign-in output captured from the real 1.4.7 CLI without a TTY and polls,
 * and `muse auth set --provider meta --api-key-stdin` saves a key read from
 * stdin. Both write `$XDG_CONFIG_HOME/muse/auth.json` in Muse's own shape and
 * refuse to run unless the account's isolated XDG pair is set. No network, no
 * real tokens.
 *
 * env FAKE_MUSE_APPROVE_MS     login: write an OAuth credential after this delay
 * env FAKE_MUSE_DENY_MS        login: print the denial and exit 1 after this delay
 * env FAKE_MUSE_AUTH_SET_FAIL  auth set: exit 1 without writing
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const config = process.env.XDG_CONFIG_HOME;
const data = process.env.XDG_DATA_HOME;
if (!config || data !== join(config, "xdg-data") || process.env.MUSE_NO_AUTO_UPDATE !== "1") {
  process.stderr.write("fake-muse: the account's XDG_CONFIG_HOME / XDG_DATA_HOME pair and MUSE_NO_AUTO_UPDATE=1 are required\n");
  process.exit(3);
}

function writeAuth(meta) {
  const path = join(config, "muse", "auth.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ schema_version: 1, providers: { meta } }, null, 2)}\n`, { mode: 0o600 });
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "login") {
  process.stdout.write("Open this page to sign in:\n  https://auth.meta.com/oauth/device/?code=FAKE-CODE\nconfirm this code matches:\n  FAKE-CODE\n\nWaiting for approval…");
  const approve = Number(process.env.FAKE_MUSE_APPROVE_MS ?? "");
  const deny = Number(process.env.FAKE_MUSE_DENY_MS ?? "");
  if (Number.isFinite(approve) && approve > 0) {
    setTimeout(() => {
      writeAuth({ mechanism: "oauth", access_token: "fake-muse-access", refresh_token: "fake-muse-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, obtained_via: "device_code" });
      process.stdout.write("\nSigned in.\n");
      process.exit(0);
    }, approve);
  } else if (Number.isFinite(deny) && deny > 0) {
    setTimeout(() => {
      process.stdout.write("\nThe login request was denied.\n");
      process.exit(1);
    }, deny);
  } else {
    setInterval(() => {}, 1000);
  }
} else if (args.join(" ") === "auth set --provider meta --api-key-stdin") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    if (process.env.FAKE_MUSE_AUTH_SET_FAIL === "1") process.exit(1);
    const key = input.trim();
    if (!key) process.exit(2);
    writeAuth({ api_key: key });
    process.stdout.write("credentials saved for provider meta\n");
    process.exit(0);
  });
} else {
  process.stderr.write(`fake-muse: unsupported invocation ${JSON.stringify(args)}\n`);
  process.exit(2);
}
