# Caller sketches

These sketches target source baseline `501710c18515c4ac077a643c50daba2ce9043958`.
They preserve every caller that omits the new option.

## Candidate A: compatibility-default recording policy

Existing source callers keep the current accepted-delivery recorder and both query methods.

```ts
const driver = new HsrDriver({
	sessionLogDir,
	resolve,
});

driver.deliver("bee-a", 1, 41, "hello");
driver.consumedGeneration(41); // 1 after acceptance
driver.consumedCount(); // 1 distinct message id
```

`CellDriver` callers also keep current behavior because `CellDriverConfig.hsr` still defaults to recording.

```ts
const cell = new CellDriver({
	...cellConfig,
	hsr: { sessionLogDir },
});

cell.consumedGeneration(41); // delegates to the inner HsrDriver
```

The built-in daemon opts out once, in the HSR config that it already shares with direct HSR and Cell.

```ts
const hsrConfig = {
	sessionLogDir: cfg.sessionLogDir,
	stopKillGraceMs: cfg.stopKillGraceMs,
	adoptToleranceMs: cfg.adoptToleranceMs,
	recordDeliveryHistory: false,
} satisfies Omit<HsrDriverConfig, "resolve">;

const hsr = new HsrDriver({
	...hsrConfig,
	resolve: (beeId) => resolveSpawnSpec(beeId),
});

const cell = new CellDriver({
	...cellConfig,
	hsr: hsrConfig,
});
```

Disabled drivers retain the existing methods so their concrete class shape does not change. Both methods throw because an empty value would look like valid evidence.

```ts
hsr.consumedGeneration(41); // throws: delivery history is disabled
hsr.consumedCount(); // throws: delivery history is disabled
cell.consumedCount(); // the inner HSR throws the same way
```

The daemon never calls these methods. `RuntimeDriver`, the daemon's extended driver contract, `SubstrateRouter`, Core, RPC, and CLI do not gain a history capability.

## Candidate B: separate runtime and compatibility drivers

This design gives history-free operation its own class. Existing names remain compatibility classes with their current recording behavior.

```ts
// Existing callers remain unchanged and retain history.
const compatibilityHsr = new HsrDriver({ sessionLogDir, resolve });
const compatibilityCell = new CellDriver({ ...cellConfig, hsr: { sessionLogDir } });

// The built-in daemon chooses distinct runtime-only classes.
const hsr = new HsrRuntimeDriver({ sessionLogDir, resolve });
const cell = new CellRuntimeDriver({ ...cellConfig, hsr: { sessionLogDir } });
```

`HsrRuntimeDriver` and `CellRuntimeDriver` expose no `consumedGeneration()` or `consumedCount()` methods. Internal base classes keep the acceptance algorithm single-sourced. A closed, module-owned recorder records at the current acceptance sites only for the compatibility classes.

This shape makes ownership clearer, but it adds two concrete classes and forces the Cell and router types to distinguish runtime-only and compatibility variants. That cost is not justified for the first HSR and Cell unit.

## Recommendation

Use Candidate A for this unit. It adds one optional construction policy, preserves omitted-option behavior, allocates no `Map` in the daemon mode, and needs no Cell production change. Candidate B is a reasonable later API cleanup if the project decides to remove the concrete history methods, but it expands this bounded change without improving daemon behavior.
