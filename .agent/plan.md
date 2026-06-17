---
schema_version: 1
run_id: "20260617042618-f2zvcf"
author_role: "planner"
---

# Phase 8F — Per-Provider Network/Proxy Mode Support

## Requirement Understanding

Phase 8F adds explicit per-provider network/proxy configuration so different provider CLIs (Codex, Claude, OpenCode, CodeBuddy, custom) can have independent proxy behavior within a single Review Loop run. The motivating scenario is mixed-provider environments: Codex (OpenAI) needs a local proxy in mainland China, while domestic Claude Code models work directly and may fail when forced through a local proxy.

The source of truth is `docs/phase-8f-provider-network-proxy-mode-support.md`. Key requirements:

- Add an optional `network` block to `ProviderConfig`/`ProviderProfile` supporting 4 `proxy_mode` values: `inherit` (default), `none`, `auto`, `custom`.
- `inherit`: preserve current behavior — full shell env inheritance, no proxy variable modification. Backwards compatible (absent `network` block == `inherit`).
- `none`: unset all proxy-related env vars (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and lowercase variants) for the child process. `NO_PROXY`/`no_proxy` preserved per spec §4.4.
- `auto`: probe `candidate_ports` (default common ports if omitted) via TCP connect on `127.0.0.1`; if a port is open, set `HTTP_PROXY`/`HTTPS_PROXY` (both cases) to `http://127.0.0.1:<port>`. If none open, fall back to `none`.
- `custom`: set `HTTP_PROXY`/`HTTPS_PROXY` (both cases) to the configured `proxy_url`.
- Env modifications apply ONLY to the provider child process at launch time — never mutate parent/global state.
- Set both uppercase and lowercase variants for cross-platform consistency.
- Cover all providers: `claude`, `codex`, `opencode`, `codebuddy`, custom.
- No changes to provider business logic, command execution, auth, or child-process security/isolation.
- Update YAML/JSON schema, provider resolution, and command spawning to honor `proxy_mode`.
- Add unit tests covering all 4 modes + integration test verifying env isolation between Codex and Claude provider commands.
- Update `docs/configuration.md` with examples (file does not yet exist — create it).
- Required gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`.

## Current Project Status

- TypeScript ESM project (`goal-review-loop`), build via `tsc`, tests via `vitest run`, lint via `eslint src/`.
- Provider model already exists:
  - `src/types.ts`: `ProviderConfig` (line 428) and `ProviderProfile` (line 465) with an `env?: Record<string,string>` field already plumbed through.
  - `src/providers/provider-registry.ts`: `createProviderRegistry`, `mergeProviderConfig`, `buildCustomProfile`, `resolveCommandForAgent`. `mergeProviderConfig`/`buildCustomProfile` copy fields explicitly and will need the new `network` field added.
  - `src/providers/builtin-providers.ts`: builtin provider definitions.
- Configuration validation: `src/artifacts/config.ts` defines an AJV `CONFIG_SCHEMA` with a `$defs.providerConfig` object schema (`additionalProperties: false`). The `network` block must be added to this schema.
- Command spawning: `src/runtime/process-runner.ts` — `runProcess` (line 269) and `runProcessRaw` (line 532) build the child `env` by copying `process.env` then overlaying `input.env`. This is the natural injection point for proxy env manipulation. The agent adapter (`src/agents/agent-adapter.ts:223`) calls `runProcess` but currently does NOT pass `env` or resolve a provider profile — it only renders the command template. The provider profile (and its `network` config) is not currently threaded into the process launch.
- Tests exist: `tests/unit/provider-registry.test.ts`, `tests/unit/config.test.ts`, `tests/unit/process-runner.test.ts`, `tests/integration/custom-provider.test.ts`. There is no `docs/configuration.md` yet.
- Base commit: `469ffec802828ebb655c2da724daf29893bec540`. Repo is otherwise clean for this phase.

## Technical Approach

### 1. Type definitions (`src/types.ts`)

Add a `ProxyMode` union type and a `ProviderNetworkConfig` interface:

```ts
export type ProxyMode = 'inherit' | 'none' | 'auto' | 'custom';

export interface ProviderNetworkConfig {
  proxy_mode: ProxyMode;
  /** Ports to probe in auto mode. Defaults to common ports if omitted. */
  candidate_ports?: number[];
  /** Required when proxy_mode === 'custom'. */
  proxy_url?: string;
}
```

Add `network?: ProviderNetworkConfig` to both `ProviderConfig` and `ProviderProfile`.

### 2. Config schema (`src/artifacts/config.ts`)

Add a `$defs.networkConfig` subschema to `CONFIG_SCHEMA` and reference it from `providerConfig.properties.network`. Validate: `proxy_mode` enum `[inherit, none, auto, custom]`; `candidate_ports` array of positive integers; `proxy_url` string (minLength 1). Add a custom validation (post-AJV) that `proxy_mode: custom` requires a non-empty `proxy_url`.

### 3. Provider resolution (`src/providers/provider-registry.ts`)

- Thread `network` through `mergeProviderConfig` and `buildCustomProfile` so resolved `ProviderProfile` carries the configured `network` block (merged: override wins, else base builtin default which is `undefined` == `inherit`).
- Add a new pure helper module `src/providers/network-env.ts` (or function in provider-registry) — `resolveProviderEnv(profile, parentEnv): Record<string,string>` — that computes the final child env for a provider given its `network` config and the parent env, WITHOUT mutating `parentEnv`. This keeps proxy logic testable in isolation:
  - `inherit`: return a shallow copy of `parentEnv` plus `profile.env` overlays (unchanged behavior).
  - `none`: copy `parentEnv`, delete the 6 proxy vars (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `http_proxy`, `https_proxy`, `all_proxy`), preserve `NO_PROXY`/`no_proxy`, apply `profile.env`.
  - `auto`: probe `candidate_ports` (default `[7890, 7897, 7899, 1080, 1087, 8080]`) via TCP connect to `127.0.0.1`; on hit set both-case `HTTP_PROXY`/`HTTPS_PROXY` to `http://127.0.0.1:<port>`; on miss fall back to `none` behavior.
  - `custom`: set both-case `HTTP_PROXY`/`HTTPS_PROXY` to `proxy_url`.
- Default `candidate_ports` constant exported for testability.

### 4. Command spawning wiring

- The cleanest, lowest-risk integration is to compute the provider env at the point where the agent command is launched and pass it through `ProcessRunnerInput.env`. Currently `runAgent` does not receive a provider profile. Two options:
  - (A) Extend `AgentRunInput` with an optional `provider_profile?: ProviderProfile` (or `network?: ProviderNetworkConfig`) and have the orchestrator/CLI pass the resolved profile; `runAgent` then calls `resolveProviderEnv` and forwards via `ProcessRunnerInput.env`.
  - (B) Compute env in the CLI/orchestrator and pass a pre-built `env` on `AgentRunInput`/`ProcessRunnerInput`.
- Recommended: **Option A** — add `network?: ProviderNetworkConfig` (or full `provider_profile`) to `AgentRunInput`, resolve it in the call sites that already resolve providers (e.g. `resolveCommandForAgent` callers / `run-orchestrator`), and in `agent-adapter.ts` build `env` via `resolveProviderEnv` and pass it to `runProcess`/`runProcessRaw` `input.env`. This keeps the proxy logic centralized and the process runner unchanged (it already overlays `input.env`).
- `process-runner.ts` needs NO change — it already copies `process.env` then overlays `input.env`. The proxy deletion for `none` mode happens in `resolveProviderEnv` before being passed in. (Important: because `process.env` is copied first in `runProcess`, a `none`-mode `env` that omits the proxy keys will NOT delete them — the keys come from `process.env`. So `resolveProviderEnv` must explicitly set those keys to empty string `''` OR the process runner must be taught to delete keys. Cleanest: have `runProcess`/`runProcessRaw` delete any key whose value is the sentinel empty string, OR pass an explicit `deleteEnv` list. **Decision:** extend `ProcessRunnerInput` with `env?: Record<string,string>` semantics unchanged, and add explicit deletion by having `resolveProviderEnv` for `none` mode return the proxy keys set to `''`; then update `runProcess`/`runProcessRaw` to delete keys whose overlay value is `''`. This is a minimal, well-contained change with a clear test.)
- Alternative (cleaner, preferred): add `env_overrides` handling where a value of `undefined`/sentinel means "delete". To keep it simple and explicit, `resolveProviderEnv` returns both the overlay map and a `deleteKeys: string[]`; extend `ProcessRunnerInput` with `delete_env?: string[]` and have both `runProcess` and `runProcessRaw` `delete` those keys from `env` after copying `process.env`. This avoids sentinel-value ambiguity and is easy to test.

### 5. Auto-mode port probing

- Use `net.createConnection({ host: '127.0.0.1', port })` with a short timeout (e.g. 200ms) and `Promise.race`. Export a `probeProxyPort(port, timeoutMs)` helper for unit testing.
- Tests must not require real network/external access (per spec). Auto-mode unit tests can spawn a local `net.Server` on an ephemeral port to simulate an open proxy, and assert the open/closed branches.

### 6. Tests

- `tests/unit/network-env.test.ts` (new): unit-test `resolveProviderEnv` for all 4 modes, default ports, custom `proxy_url`, both-case variable handling, `NO_PROXY` preservation, parent-env immutability.
- `tests/unit/process-runner.test.ts` (extend): assert `delete_env` keys are removed from the spawned child env (use a fixture that prints env, or mock `spawn`).
- `tests/unit/provider-registry.test.ts` (extend): assert `network` block threads through `mergeProviderConfig`/`buildCustomProfile`.
- `tests/unit/config.test.ts` (extend): assert `network` block validates (valid/invalid `proxy_mode`, `custom` requires `proxy_url`).
- `tests/integration/provider-network.test.ts` (new): launch two provider commands (Codex-like and Claude-like fixtures, e.g. small node scripts that write their `HTTP_PROXY` env to stdout) with different `proxy_mode` and assert env isolation — one sees the proxy, the other does not, and the parent `process.env` is unchanged.

### 7. Docs

- Create `docs/configuration.md` documenting the `network` block, all 4 modes, `candidate_ports`, `proxy_url`, cross-platform notes, and per-provider examples (Codex `auto`, domestic Claude `none`, custom opencode `custom`).

## Work Breakdown

1. **Types**: Add `ProxyMode`, `ProviderNetworkConfig`, `network?` field to `ProviderConfig`/`ProviderProfile` in `src/types.ts`.
2. **Schema**: Add `networkConfig` subschema + custom `custom`-requires-`proxy_url` validation in `src/artifacts/config.ts`.
3. **Provider env resolver**: Implement `resolveProviderEnv` + `probeProxyPort` + default ports constant (new `src/providers/network-env.ts`).
4. **Registry threading**: Pass `network` through `mergeProviderConfig`/`buildCustomProfile` in `src/providers/provider-registry.ts`.
5. **Process runner delete_env**: Add `delete_env?: string[]` to `ProcessRunnerInput`; apply deletion in `runProcess` and `runProcessRaw`.
6. **Agent adapter wiring**: Add `network?` (or provider profile) to `AgentRunInput`; compute env via `resolveProviderEnv` and pass `env`/`delete_env` into `runProcess` in `src/agents/agent-adapter.ts`. Thread resolved profile from orchestrator/CLI call sites.
7. **Unit tests**: `network-env.test.ts` (all 4 modes), extend `provider-registry`, `config`, `process-runner` tests.
8. **Integration test**: `tests/integration/provider-network.test.ts` — env isolation between two provider commands.
9. **Docs**: Create `docs/configuration.md` with examples.
10. **Verify**: Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`.

## Risks

- **Env deletion semantics**: `process.env` is copied first in `runProcess`, so `none`/`auto`-fallback must explicitly delete proxy keys, not merely omit them. Mitigated by `delete_env` mechanism + dedicated tests.
- **Auto-mode port probing flakiness**: TCP probes against `127.0.0.1` could be racy in CI. Mitigated by using ephemeral `net.Server` in tests and short timeouts; auto mode falls back to `none` when nothing is open (safe default).
- **Threading provider profile into agent runs**: The orchestrator/CLI currently resolves providers for command templates but may not pass the full profile to `runAgent`. Requires tracing all `runAgent`/`AgentRunInput` call sites to ensure the `network` config reaches the launch point without regressions. Risk contained by typecheck + existing adapter tests.
- **Backwards compatibility**: Any provider config without a `network` block must behave exactly as before. Mitigated by defaulting absent `network` to `inherit` and a regression test asserting no env change.
- **Cross-platform case handling**: Windows treats env vars case-insensitively; Node's `process.env` is case-insensitive on Windows but case-sensitive on Unix. Setting both cases explicitly covers all platforms; tests assert both variants.
- **Scope creep**: Must not touch provider business logic, Verification Runner, Scope Guard, or security. `allowed_changes` restricted to `src/**` and `tests/**` plus the new `docs/configuration.md` (docs path must be added to `allowed_changes`).
- **No external network**: Per spec, implementation/tests must not require external network access. All proxy tests use `127.0.0.1` only.
