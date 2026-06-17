---
schema_version: 1
run_id: "20260617042618-f2zvcf"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---

# Phase 8F: Per-Provider Network/Proxy Mode Support

## Summary of Changes

Implemented Phase 8F per-provider network/proxy configuration supporting 4 proxy modes (`inherit`, `none`, `auto`, `custom`) so different provider CLIs can have independent proxy behavior within a single Review Loop run.

## Files Changed

### New Files

- **`src/providers/network-env.ts`** — Core env-resolver module with `resolveProviderEnv()`, `probeProxyPort()`, `DEFAULT_CANDIDATE_PORTS`, `PROXY_ENV_KEYS`, `NO_PROXY_KEYS`, and `ResolvedProviderEnv` interface. Implements all 4 proxy modes without mutating any external state.

- **`tests/unit/network-env.test.ts`** — Unit tests covering all 4 proxy modes, default candidate ports, custom proxy_url, both-case variable handling, NO_PROXY preservation, port-probe open/closed branches (using ephemeral `net.Server`), and regression test for inherit mode.

- **`tests/integration/provider-network.test.ts`** — Integration test verifying env isolation between Codex-like (none mode) and Claude-like (custom mode) provider commands, parent env immutability, and inherit mode regression.

- **`docs/configuration.md`** — Documentation for the `network` block, all 4 modes, `candidate_ports`, `proxy_url`, cross-platform notes, and per-provider YAML examples.

### Modified Files

- **`src/types.ts`** — Added `ProxyMode` type, `ProviderNetworkConfig` interface, `network?: ProviderNetworkConfig` to `ProviderConfig` and `ProviderProfile`, `network?: ProviderNetworkConfig` to `AgentRunInput`, `delete_env?: string[]` to `ProcessRunnerInput`.

- **`src/artifacts/config.ts`** — Added `networkConfig` subschema to `CONFIG_SCHEMA` with `proxy_mode` enum, `candidate_ports` array, `proxy_url` string. Added `validateNetworkConfig()` function that rejects `custom` mode without `proxy_url`. Imported `ProviderNetworkConfig` and `ProviderConfig` types.

- **`src/providers/provider-registry.ts`** — Threaded `network` field through `mergeProviderConfig()` and `buildCustomProfile()`.

- **`src/runtime/process-runner.ts`** — Added `delete_env` handling in both `runProcess()` and `runProcessRaw()`: after copying `process.env` and applying `input.env` overlay, deletes keys listed in `input.delete_env`.

- **`src/agents/agent-adapter.ts`** — Imported `resolveProviderEnv`. When `input.network` is set, resolves provider env and passes `env`/`delete_env` to `runProcess`.

- **`tests/unit/provider-registry.test.ts`** — Added 3 tests for network block threading through `mergeProviderConfig`, `buildCustomProfile`, and undefined network preservation.

- **`tests/unit/config.test.ts`** — Added 8 tests for network config validation: valid modes (inherit, none, auto, custom), invalid proxy_mode, custom without proxy_url, backward compat (no network block), and `validateNetworkConfig` unit tests.

- **`tests/unit/process-runner.test.ts`** — Added 3 tests for `delete_env`: deleting specified keys, empty delete_env array, and non-existent keys.

## Verification Performed

All 5 required verification gates passed:

1. **`npm test`** — 55 test files, 917 tests passed (including all new tests)
2. **`npm run typecheck`** — TypeScript compilation with no errors
3. **`npm run lint`** — ESLint with 0 warnings/errors
4. **`npm run build`** — `tsc` build succeeded
5. **`git diff --check`** — No whitespace errors

## Risks

- **Auto-mode port probing**: TCP probes against `127.0.0.1` could be racy in CI environments with slow networking. Mitigated by short timeout (200ms) and safe fallback to `none` mode when no port is open.
- **Env deletion semantics**: The `delete_env` mechanism deletes keys from the child env after copying `process.env`. If a future change modifies the env construction order, the deletion must still happen after the overlay.
- **Backward compatibility**: Providers without a `network` block default to `inherit` (no changes). Verified by regression test.

## Unresolved Issues

None. All success criteria from the GOAL are met.
