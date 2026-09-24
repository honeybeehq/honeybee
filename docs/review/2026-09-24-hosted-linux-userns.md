# Hosted Ubuntu bubblewrap prerequisite

Base: `27baabf90f95a0898d6e1c10e34e41a2256a1cf8`. Branch: `codex/fix-hosted-linux-userns`.

The source CI job failed before tests in [run 36021760975](https://github.com/honeybeehq/honeybee/actions/runs/36021760975):

```text
bwrap: setting up uid map: Permission denied
```

The run used Ubuntu 24.04.5, image `20260920.314.1`, and bubblewrap `0.9.0-1ubuntu0.3` (amd64). The [image manifest](https://github.com/actions/runner-images/blob/ubuntu24/20260920.314/images/ubuntu/Ubuntu2404-Readme.md) identifies kernel `6.17.0-1022-azure`. Its captured log contains no kernel audit diagnostics, so the AppArmor attribution must be distinguished from directly observed hosted-runner audit evidence.

Ubuntu's [user-namespace restriction explanation](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007) describes the relevant mechanism: an unconfined process can create a namespace but be denied the capabilities required to configure it. Ubuntu supplies a bubblewrap profile for this use case. The earlier privileged Docker validation used LinuxKit without AppArmor and could not exercise this restriction.

## Change

Install `apparmor-profiles` and load its packaged `/usr/share/apparmor/extra-profiles/bwrap-userns-restrict` with `apparmor_parser -r`. The Noble ABI 4 profile attaches to `/usr/bin/bwrap`, permits its namespace setup, and stacks a child profile that denies capabilities. This uses the distribution's policy rather than maintaining a custom allow-all profile.

The preflight remains byte-for-byte unchanged and runs as the ordinary CI user. No global AppArmor/user-namespace setting, product sandbox policy, test assertion, release workflow, or runtime implementation changes.

## Validation

The reproduction uses an isolated Ubuntu 24.04.5 cloud-image VM, booted with its own `6.8.0-139-generic` arm64 kernel under QEMU. QEMU runs in a private Docker container without host mounts; the sandbox commands execute inside the guest, not on Docker's LinuxKit kernel. The test user is UID 1000, AppArmor is enabled, `kernel.apparmor_restrict_unprivileged_userns=1`, and `user.max_user_namespaces=7533`.

Before loading a profile, the exact workflow preflight failed twice with `bwrap: setting up uid map: Permission denied`. Guest kernel audit records identify the transition from `unconfined` to `unprivileged_userns`, then denial of the `proc/<pid>/uid_map` write. This reproduces the hosted symptom and supports AppArmor as its cause; the hosted run itself did not capture those audit records.

The installed `apparmor-profiles` and AppArmor versions are `4.0.1really4.0.1-0ubuntu0.24.04.8`; bubblewrap remains `0.9.0-1ubuntu0.3`. Installing the profile package also upgraded AppArmor from `.7` to `.8`. The control after installation isolates explicit profile loading from that upgrade:

| Guest check | Result |
| --- | --- |
| Exact preflight before profile-package installation | UID-map denial twice |
| Exact preflight after package installation, profile not loaded | Same UID-map denial twice |
| Load packaged profile, run exact preflight as UID 1000 | Passed |
| Child security state | `bwrap//&unpriv_bwrap (enforce)`, effective/permitted capabilities both zero, `NoNewPrivs=1` |
| Copy `/usr/bin/bwrap` to an unprofiled path and run identical arguments | Still denied at UID map |
| Sandboxed child attempts another namespace setup | Denied; kernel audit attributes `sys_admin` capability denial to `unpriv_bwrap` |
| Unload the profile, then retry | Same UID-map denial twice |
| Reload the profile, then retry | Passed; global restriction still `1` |
| Unchanged `hsr-cell-sandbox` test file with profile enforced | 10 passed, one macOS-only skip, one known native package-hook failure |

The native integration test executed real sandboxed operations and reached the existing `node_modules/pkg/.git/hooks/postinstall` rejection assertion; it was not skipped. Earlier assertions, including Cell writes and canonical/store write fencing, passed. Later assertions and the local HTTP server portion remain unverified because the test stops at that baseline failure. No assertion was removed or bypassed. The guest used Node 24.15.0 and the compiled tests/dependencies copied from the separately validated Linux fixture; it did not perform a separate `npm ci`.

The small reproduction on an isolated Ubuntu 24.04 VM is:

```sh
# Run as an ordinary user; sudo is only for installing/loading the prerequisite.
probe() {
  "$1" --new-session --die-with-parent --ro-bind / / --dev /dev \
    --unshare-user --cap-drop ALL --unshare-pid --proc /proc -- /bin/true
}
sudo apt-get install -y tmux bubblewrap ripgrep socat apparmor-profiles
probe /usr/bin/bwrap  # fails before the extra profile is loaded
sudo apparmor_parser -r /usr/share/apparmor/extra-profiles/bwrap-userns-restrict
probe /usr/bin/bwrap  # succeeds
sysctl kernel.apparmor_restrict_unprivileged_userns  # still 1
cp /usr/bin/bwrap /tmp/unprofiled-bwrap
probe /tmp/unprofiled-bwrap  # still fails
```

Fixture limitation: the cloud-image's optional `cnf-update-db` command-suggestion index rebuild was stopped after several minutes under CPU emulation. This caused the first `apt-get update` to report its post-hook error after downloading the indexes; installing the prerequisites from those indexes then succeeded. No security setting or package policy was changed to bypass that metadata work. This is a mechanism reproduction, not execution on an identical GitHub image.

Separate Ubuntu 24.04 Docker fixture, nonroot UID 1001, Node 24.15.0:

- `npm run check`, `npm run v2:check`, `npm run build`, and `npm run build:test`: passed.
- Focused `tests/hsr-cell-sandbox.test.ts`: 10 passed, one macOS-only skip, one existing native package-hook failure. Native containment was executed, not skipped. This is the same failure documented and reproduced on the actual pre-feature revision in [the earlier receipt](2026-09-24-linux-ci-fixture-repair.md).
- Workflow YAML parsing and `git diff --check`: passed.

These are focused checks for a workflow-only change. The unchanged broad source/v2 suites were not rerun for this follow-up; their earlier results, including the unrelated tmux timing failure, remain in the previous receipt.

## Review and limits

Independent standards and functional/spec reviewers inspected the final diff, receipt, and recorded evidence. Both reported zero actionable findings. Reviews were read-only; execution evidence above comes from the primary agent.

No GitHub workflow was dispatched or claimed green. No push, release, deployment, live Jev call, Mac runner, or unrelated baseline repair was performed. Hosted x64/Azure-kernel acceptance requires the parent's subsequent integration run.

Local evidence is retained in `/tmp/honeybee-userns-vm-{red,after-package-red,green,audit,toggle,native,profile-install,packages,prerequisites}.log` and `/tmp/honeybee-hosted-userns-validation.log`. The red/green harnesses are `/tmp/honeybee-userns-{red,green}.sh`; the preflight was extracted directly from the parsed workflow YAML. The original hosted logs are `/tmp/honeybee-36021760975{,-failed}.log`.

Prevention lesson: a privileged container cannot validate a host-kernel security prerequisite it does not implement. Keep the native preflight mandatory and use a kernel with AppArmor enabled to validate changes to Ubuntu's namespace admission.
