# Phase 8F-R1 Plugin Test Report

**Test date**: 2026-06-17
**Test method**: `review-loop start --request-file docs/phase-8f-r1-provider-launch-hardening.md --task-slug phase-8f-r1-provider-launch-hardening --no-commit --watch`
**Run ID**: `20260617055023-8x5fle`
**Outcome**: BLOCKED at PLANNING — Planner could not write artifacts

## Environment

- `review-loop` CLI: installed via npm link, available in PATH
- `codex`: `/usr/local/bin/codex`, version `0.140.0-alpha.19`
- `claude`: version `2.1.177`
- Node.js: `v23.11.0` (triggers `EBADENGINE` warning, non-blocking)
- Parent shell proxy: `HTTP_PROXY=http://127.0.0.1:7897`, `HTTPS_PROXY=http://127.0.0.1:7897`
- No `review-loop.yaml` in repo — run used `DEFAULT_CONFIG`

## Findings

### P0-1: Codex sandbox blocks Planner artifact writes (BLOCKING)

**Severity**: Blocking — run cannot pass PLANNING

**Evidence**: Planner (Codex) successfully generated a complete plan and GOAL in its reasoning, but could not write them to disk:

```
Every location is read-only. This environment's sandbox (`read-only` mode) blocks all writes,
so I cannot create or modify `.agent/plan.md` or `.agent/GOAL.md` on disk.
```

**Root cause**: `DEFAULT_CONFIG.agents.planner.command` is `['codex', 'exec', '{prompt_file}']` without the `-s workspace-write` flag. Codex CLI defaults to `read-only` sandbox.

**Impact**: No Review Loop run can complete PLANNING with the default config when using Codex as Planner.

**Fix**: `DEFAULT_CONFIG` must include `-s workspace-write` for all Codex-based agent commands (planner, auditor, final_auditor). This was already documented in `review-loop-test-report.md` problem #3 but was never applied to the built-in defaults.

### P0-2: No `review-loop.yaml` in repo — defaults are not dogfood-safe (BLOCKING)

**Severity**: Blocking — first-time users hit P0-1 immediately

**Evidence**: The repo has no `review-loop.yaml`. `loadConfigWithDefaults` falls back to `DEFAULT_CONFIG`, whose Codex commands lack `-s workspace-write` and whose Claude developer command uses the stdin+login-shell pattern that Phase 8F-R1 explicitly flags as unsafe.

**Impact**: A user who clones this repo and runs `review-loop start` without hand-writing a config will hit sandbox write failures and proxy reintroduction.

**Fix**: Ship a `review-loop.yaml` with dogfood-safe defaults, or fix `DEFAULT_CONFIG` so it works out of the box.

### P1-1: `TimeoutNaNWarning: NaN is not a number` at run start

**Severity**: Non-blocking but indicates a config/threading bug

**Evidence**: stderr at run start:
```
(node:4152) TimeoutNaNWarning: NaN is not a number.
Timeout duration was set to 1.
```

**Root cause**: Likely a `timeout_ms` value resolving to NaN somewhere in the orchestrator → agent-adapter → process-runner chain, possibly when an optional field is missing.

**Fix**: Trace `timeout_ms` / `kill_grace_seconds` propagation and ensure NaN cannot reach `setTimeout`.

### P1-2: Planner "completed" but artifacts were stale

**Severity**: Misleading state — orchestrator marked Planner as completed even though file writes failed

**Evidence**: `progress.json` showed `last_event: "Planner completed"` and `stages.planning.status: "running"`, but `.agent/plan.md` and `.agent/GOAL.md` timestamps were unchanged from a previous run. The orchestrator did not detect that the Planner failed to produce fresh artifacts.

**Root cause**: The artifact freshness check may not have triggered because the Planner process exited with code 0 (Codex returned success despite not writing files).

**Fix**: The Planner adapter should verify that `plan.md` and `GOAL.md` were actually modified (digest changed) before marking the stage complete. The `verifyArtifactFreshness` function exists but may not be wired into the Planner path, or Codex's exit code 0 bypassed the check.

### P1-3: `review-loop-test-report.md` blocks preflight (already fixed)

**Severity**: Was blocking — fixed during this test

**Evidence**: `git status --porcelain=v1 -uall` showed `?? review-loop-test-report.md`, causing preflight `dirty_worktree` rejection.

**Fix applied**: Added `review-loop-test-report.md` to `.gitignore` and committed (`df47a8a`).

## What worked

- `review-loop providers list` correctly shows 4 providers with transport and command info.
- `review-loop providers test codex` and `providers test claude` both PASS (health check only).
- Orchestrator preflight correctly detected git state, created run state, and launched Planner.
- Codex (via domestic gateway `127.0.0.1:57321`) successfully performed reasoning and generated a complete, high-quality plan that addresses all 8 Phase 8F-R1 requirements.
- Watch mode displayed progress events.
- Cancel/cleanup worked correctly.

## Recommendations

1. Fix `DEFAULT_CONFIG` to include `-s workspace-write` for Codex commands — this is the single highest-impact fix.
2. Ship a `review-loop.yaml` with safe defaults for this repo.
3. Investigate and fix the `TimeoutNaNWarning`.
4. Ensure Planner artifact freshness is verified before marking PLANNING complete.
5. These findings validate the Phase 8F-R1 requirements document — the problems it describes (provider launch hardening, prompt transport, proxy stripping) are real and reproducible.
