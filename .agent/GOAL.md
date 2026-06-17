---
schema_version: 1
run_id: "20260617042618-f2zvcf"
goal_id: "phase-8f-provider-network-proxy-mode"
title: "Phase 8F: Per-Provider Network/Proxy Mode Support"
allowed_changes:
  - "src/**"
  - "tests/**"
  - "docs/configuration.md"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
verification_commands:
  - id: "unit-tests"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
  - id: "typecheck"
    command: ["npm", "run", "typecheck"]
    cwd: "."
    required: true
    timeout_seconds: 300
  - id: "lint"
    command: ["npm", "run", "lint"]
    cwd: "."
    required: true
    timeout_seconds: 300
  - id: "build"
    command: ["npm", "run", "build"]
    cwd: "."
    required: true
    timeout_seconds: 300
  - id: "diff-check"
    command: ["git", "diff", "--check"]
    cwd: "."
    required: true
    timeout_seconds: 120
---

# Phase 8F: Per-Provider Network/Proxy Mode Support

## Objective

Implement Phase 8F per `docs/phase-8f-provider-network-proxy-mode-support.md` (the source of truth). Add per-provider network/proxy configuration supporting 4 proxy modes — `inherit`, `none`, `auto`, `custom` — so different provider CLIs (Codex, Claude, OpenCode, CodeBuddy, custom) can have independent proxy behavior within a single Review Loop run. Update the YAML/JSON config schema, provider resolution, and command spawning to honor `proxy_mode`. Add unit tests for all 4 modes and an integration test verifying environment isolation between Codex and Claude provider commands. Create `docs/configuration.md` with examples. Do not modify provider business logic, authentication, command execution semantics, or child-process security — only adjust environment variables at child-process launch time.

## Success Criteria

1. `ProviderConfig` and `ProviderProfile` types in `src/types.ts` include an optional `network` block with `proxy_mode` (`inherit` | `none` | `auto` | `custom`), optional `candidate_ports`, and optional `proxy_url`; a `ProxyMode` type and `ProviderNetworkConfig` interface are exported.
2. The config schema in `src/artifacts/config.ts` validates the `network` block: `proxy_mode` is one of the 4 values; `candidate_ports` is an array of positive integers; `custom` mode requires a non-empty `proxy_url` (rejected with a `ConfigError` otherwise). An absent `network` block is valid and defaults to `inherit`.
3. Provider resolution in `src/providers/provider-registry.ts` threads the `network` block through `mergeProviderConfig` and `buildCustomProfile`, so a resolved `ProviderProfile` carries its configured `network` settings.
4. A pure, testable env-resolver (e.g. `src/providers/network-env.ts`) computes the provider child-process environment from the parent env and the profile's `network` config, WITHOUT mutating the parent env, implementing all 4 modes:
   - `inherit`: no proxy variable modification (current behavior preserved).
   - `none`: unsets `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `http_proxy`, `https_proxy`, `all_proxy`; preserves `NO_PROXY`/`no_proxy`.
   - `auto`: TCP-probes `candidate_ports` (default `[7890, 7897, 7899, 1080, 1087, 8080]`) on `127.0.0.1`; on an open port sets both-case `HTTP_PROXY`/`HTTPS_PROXY` to `http://127.0.0.1:<port>`; on no open port falls back to `none` behavior.
   - `custom`: sets both-case `HTTP_PROXY`/`HTTPS_PROXY` to the configured `proxy_url`.
5. Command spawning honors `proxy_mode`: the agent adapter (`src/agents/agent-adapter.ts`) passes the resolved provider env into the process runner so the provider child process receives the modified proxy variables. Both uppercase and lowercase variants are set for cross-platform consistency.
6. Environment modifications apply ONLY to the provider child process — the parent `process.env` is never mutated (verified by test).
7. `proxy_mode: inherit` (and absent `network` block) produces behavior identical to pre-Phase-8F (no regressions; verified by a regression test).
8. Unit tests cover all 4 proxy modes plus default `candidate_ports`, custom `proxy_url`, both-case variable handling, `NO_PROXY` preservation, parent-env immutability, and port-probe open/closed branches (using a local `127.0.0.1` ephemeral server — no external network access).
9. An integration test verifies environment isolation between two provider commands (e.g. a Codex-like provider with a proxy mode and a Claude-like provider with `none`) launched in the same run: each child sees only its own proxy env, and the parent env is unchanged.
10. `docs/configuration.md` is created and documents the `network` block, all 4 modes, `candidate_ports`, `proxy_url`, cross-platform notes, and per-provider YAML examples (Codex `auto`, domestic Claude `none`, custom opencode `custom`).
11. No changes are made to provider business logic, command execution, authentication, Verification Runner, Scope Guard, or child-process security/isolation beyond environment variable handling.
12. All required verification gates pass: `unit-tests` (`npm test`), `typecheck` (`npm run typecheck`), `lint` (`npm run lint`), `build` (`npm run build`), and `diff-check` (`git diff --check`).

## Non-Goals

- Do not implement a built-in proxy client, VPN, or network tunneling.
- Do not modify proxy software or system network configuration.
- Do not change provider/model API calling logic or authentication handling.
- Do not push to remote or perform destructive git operations.
- Do not modify Verification Runner, Scope Guard, or other non-provider core behavior.
- Do not weaken existing child-process security or isolation.
- Do not require external network access for implementation or tests (all proxy tests use `127.0.0.1`).

## Constraints

- Source of truth: `docs/phase-8f-provider-network-proxy-mode-support.md`.
- TypeScript ESM project; build via `tsc`, tests via `vitest run`, lint via `eslint src/ --max-warnings=0`.
- Keep changes minimal and consistent with existing code style.
- Only edit files under `src/**`, `tests/**`, and `docs/configuration.md`.
- Do not create or edit `.agent/verification/**`.
- Do not edit `.agent/state.json`, `.agent/GOAL.md`, `.agent/audit-report.md`, `.agent/final-audit.md`, or anything under `.git/**`.
- Preserve backwards compatibility: providers without a `network` block behave exactly as before.
