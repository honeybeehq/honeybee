# KVM in Linux Cells

On each host that should allow Android emulator acceleration, set
`cells.kvm` to `true` in the node's `<dataDir>/config.json` (normally
`~/.hive/v2/config.json`), preserving its other settings:

```json
{
  "cells": {
    "kvm": true
  }
}
```

The setting defaults to `false`. It applies to sandboxed Cell harnesses and
retained Cell commands on that host. Linux binds exactly `/dev/kvm` into
bubblewrap's private `/dev`; all other device visibility, filesystem rules,
and namespace settings stay unchanged. macOS ignores this Linux setting.

The user running Honeybee must already be able to open `/dev/kvm` on the
host, usually through the `kvm` supplementary group. Bubblewrap retains the
underlying group credentials, even when unmapped groups appear as `65534`
inside its user namespace. This option does not add groups, preserve extra
groups, change device permissions, or expose the host's `/dev` directory.
An enabled setting fails the spawn if `/dev/kvm` is missing; it does not
silently run without acceleration.

Deploy through `hive deploy` and restart the daemon through the supported
deployment path to load the setting. Existing Cell processes keep their
current mounts. Setting it back to `false` hides KVM for subsequent launches.

On metal-3 or metal-1, verify with a disposable provisioned Cell:

```sh
node v2/driver-cell/kvm-smoke.ts
```

The smoke creates its own tiny Git origin and scratch Cell without using
the live daemon. It checks the host can create a KVM VM, then checks disabled,
enabled, and disabled again through the real Cell exec path and parsed host
configuration. It verifies that only `/dev/kvm` appears, supplementary groups
do not change, other host devices remain hidden, and writes outside the Cell
fail. It prints the scratch fixture location and leaves it for inspection.
It neither edits host configuration nor touches live Cells or bees.
