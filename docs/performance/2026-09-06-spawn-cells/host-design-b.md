Design B is ready. It needs three production edits, adds no caller metadata, and changes no runtime protocol or lifecycle behavior. No files were modified. Per your last instruction, I did not cross-judge A.

## Caller’s view

Production daemon and Cell construction lose the inferred callback:

```ts
const hsrConfig = {
  sessionLogDir: this.cfg.sessionLogDir,
  stopKillGraceMs: this.cfg.stopKillGraceMs,
  adoptToleranceMs: this.cfg.adoptToleranceMs,
};

const hsr = new HsrDriver({
  ...hsrConfig,
  resolve: (beeId) => this.resolveSpawnSpec(beeId),
});

const cell = new CellDriver({
  // existing Cell settings
  hsr: hsrConfig,
});
```

Source users keep the current zero-configuration form:

```ts
new HsrDriver({ sessionLogDir, resolve });
```

Custom layouts keep the existing override unchanged:

```ts
new HsrDriver({
  sessionLogDir,
  resolve,
  hostCommand: (configPath) => ({
    command: customNode,
    args: [customRunnerHost, configPath],
  }),
});
```

No `moduleUrl`, deployment path, mode flag, or new daemon dependency enters any caller.

## Signature and resolution sketch

The public configuration remains unchanged:

```ts
export interface HsrDriverConfig {
  resolve(beeId: string): SpawnSpec;
  sessionLogDir: string;
  stopKillGraceMs?: number;
  adoptToleranceMs?: number;
  now?: () => number;
  runnersDir?: string;
  hostCommand?: (
    configPath: string,
  ) => { command: string; args: string[] };
}
```

Only the existing private method changes:

```ts
private hostCommandFor(
  configPath: string,
): { command: string; args: string[] } {
  if (this.cfg.hostCommand) {
    return this.cfg.hostCommand(configPath);
  }

  const ownPath = fileURLToPath(import.meta.url);

  if (extname(ownPath) === ".ts") {
    const sourceEntry = fileURLToPath(
      new URL("./runner-host-main.ts", import.meta.url),
    );
    return {
      command: process.execPath,
      args: ["--experimental-strip-types", sourceEntry, configPath],
    };
  }

  const builtEntry = fileURLToPath(
    new URL("./runner-host.js", import.meta.url),
  );
  return {
    command: process.execPath,
    args: [builtEntry, configPath],
  };
}
```

The method follows three rules in order:

1. An explicit override always wins.
2. A source-loaded driver runs the existing TypeScript entry.
3. A bundled driver runs the dedicated sibling artifact.

There is no existence-based fallback to the full CLI. A missing sibling is a broken package and must fail the build or packaging tests.

## Module map

| File | Change |
|---|---|
| [driver.ts](../../../v2/driver-hsr/src/driver.ts) | Extend `hostCommandFor` with source and bundled sibling resolution. Update its stale comment. |
| [build-v2-artifact.mjs](../../../scripts/build-v2-artifact.mjs) | Add an esbuild entry from `runner-host-main.ts` to `dist/v2/runner-host.js`, using the existing Node ESM settings. |
| [daemon.ts](../../../v2/daemon/src/daemon.ts) | Delete the `process.argv[1]` regex and generated `hostCommand`. Keep the shared HSR settings used by direct HSR and Cell. |
| [main.ts](../../../v2/cli/src/main.ts) | No behavior change. Retain the hidden `runner-host` verb as compatibility plumbing. |
| [deploy-settle.test.ts](../../../tests/deploy-settle.test.ts) | Require `dist/v2/runner-host.js` in the packed archive. |

No new production module is needed.

## Preserved invariants

- `HsrDriver.start` still writes the same `RunnerHostConfig`.
- The host still starts through `process.execPath`, detached, with ignored stdio.
- Host PID and birth time remain the durable runtime identity.
- TERM/KILL process-group behavior is unchanged.
- Status files, observation journals, delivery sockets, adoption, and recovery are untouched.
- Cell uses the same resolution because it delegates to its inner `HsrDriver`.
- The lightweight artifact imports only `runner-host-main.ts`, `runner-host.ts`, and Node built-ins. It imports no CLI, daemon, adapter, or provider code.
- A renamed or embedded outer entry does not matter. Resolution uses the bundled module’s `import.meta.url`, not `argv[1]`.
- In a versioned deployment, Node realpath-resolves the module URL into `runtime/<sha>`. Retargeting `runtime/current` therefore cannot change which sibling an already-running daemon launches.

## Concrete tests

- Source default: retain the real no-override coverage in `v2/driver-hsr/tests/runner-host.test.ts`. It must continue launching `runner-host-main.ts`.
- Explicit override: add a real-process test whose callback records the config path and launches the source host. Assert one callback invocation and normal readiness.
- Packaged sibling: after the production build, assert `dist/v2/runner-host.js` exists and `npm pack --dry-run` includes it.
- Artifact isolation: execute the staged `runner-host.js` with a disposable config and stub agent. Assert status, observation, socket, and clean exit behavior.
- Renamed embedding: copy the actual built v2 CLI bundle under an arbitrary filename beside `runner-host.js`; invoke it through an unrelated wrapper filename and prove an HSR spawn reaches readiness.
- Immutable symlink: start that wrapper through `runtime/current -> release-a`, retarget `current -> release-b` with a poisoned or missing host artifact, then spawn. The running release-A daemon must still use release A’s sibling.
- Direct-host assertion: inspect the spawned host command and require `runner-host.js`; reject `cli.js`, `v2 runner-host`, and the wrapper path.
- Hidden compatibility: invoke the existing hidden CLI verb with a terminating disposable config and verify it still runs.
- Recovery parity: rerun the existing runner-host restart, adoption, delivery, exact-stop, daemon lifecycle, and Cell driver suites unchanged.

## Tradeoffs

- We accept a few kilobytes duplicated between the dedicated artifact and the compatibility CLI bundle. Each runtime avoids loading the roughly 1 MB CLI graph.
- We make sibling co-location a firm packaging contract. This is safer than silently reverting to the expensive CLI path.
- We use the module extension to distinguish source execution from bundled execution. That matches the repository’s actual `.ts` source and `.js` deployment forms without adding configuration.

The first implementation unit is the artifact plus packaged-sibling test. The second changes `hostCommandFor` and removes daemon inference. Heavy verification and post-change measurements wait for the parent’s implementation go.
