# Champion Claude SDK spike

Studio-only, three sequential mails on one streaming SDK session, with a 15-second pause before mail 3. Synthetic memory makes the fixed system prefix large enough to measure cache reuse. This is an experimental probe, not a Honeybee runtime adapter.

The pinned account is `claude-claude-trmd-trmd.me`. Only the SDK child receives real HOME, by an explicit human-approved exception. The bridge and all build commands use a Cell-local HOME. No ambient environment is forwarded to the SDK child. The bridge does not implement credential reading, copying, refreshing or account switching; the installed Anthropic CLI owns authentication. This does not prove that the CLI never refreshes internally.

Install with `npm ci`, then `npm run check` and `npm run build` in this directory, using the Cell-local env required by the worker brief. Run from the repository root:

```sh
v2/experimental/champion-harness/claude-sdk/launch.sh
```

The launcher applies `runtime.sb` to the bridge and descendants. Writes are limited to `.audit/claude-sdk` and the pinned account config directory. The bridge probes an outside write and requires EPERM/EACCES before sending model mail. It logs SDK-loaded tools, MCP servers, skills and plugins and refuses unexpected capabilities. The SDK does not expose loaded settings source provenance in its init type; evidence labels the empty settingSources as configured, not independently observed.

Output goes to a fresh timestamped `.audit/claude-sdk/sandbox-run-*` directory: `measurements.json` and a sanitized `run.jsonl`. Usage is the SDK result's per-turn main-loop usage. Cumulative model usage is logged separately and must not be summed across turns. First ack measures first text delta, falling back to a non-error assistant message; it includes local SDK latency from mail submission. No general speedup claim follows from one run.

The process ends after three results or an SDK error. Stop only this launch's PID with SIGTERM if needed. No deployed runtime, routing or Honeybee account configuration changes are made. Queen must review credential wiring and real-run evidence before landing.
