# Phase 8F-R1 Plugin Test Report

**Test dates**: 2026-06-17
**Test method**: `review-loop start --request-file docs/phase-8f-r1-provider-launch-hardening.md` in source repo
**Run IDs**: `20260617055023-8x5fle` (round 1), `20260617061120-48rdmu` (round 2), `20260617063937-ysoj7w` (round 3)

## Round 1: Source repo, no config (8x5fle)

**Outcome**: BLOCKED at PLANNING — Codex sandbox blocked writes

### P0-1: Codex sandbox blocks Planner artifact writes (BLOCKING) — FIXED

`DEFAULT_CONFIG` Codex commands lacked `-s workspace-write`. Codex defaults to read-only sandbox, could not write `plan.md`/`GOAL.md`.

**Fix applied**: Created `review-loop.yaml` with `-s workspace-write` for all Codex agents (`cd563ad`).

### P0-2: No `review-loop.yaml` in repo (BLOCKING) — FIXED

Repo had no config file; fell back to unsafe `DEFAULT_CONFIG`.

**Fix applied**: Shipped `review-loop.yaml` with safe Claude argv launch + proxy stripping (`cd563ad`).

### P1-1: `TimeoutNaNWarning` at run start

`TimeoutNaNWarning: NaN is not a number` appears every run start. `timeout_ms` reaches `setTimeout` as NaN. **Not yet fixed.**

### P1-2: "Planner completed" emitted before success check

Orchestrator emits `lastEvent: 'Planner completed'` unconditionally before checking status. **Not yet fixed.**

### P1-3: `review-loop-test-report.md` blocks preflight — FIXED

Untracked file caused `dirty_worktree` rejection. Added to `.gitignore` (`df47a8a`).

## Round 2: Source repo with safe config (48rdmu)

**Outcome**: BLOCKED at DEVELOPING — Claude API empty response

Planner (Codex) succeeded with `-s workspace-write`. Developer (Claude) started editing code (added `shell_mode` and `provider_kind` to `src/types.ts` and `src/artifacts/config.ts`), then Claude API returned:

```
API Error: API returned an empty or malformed response (HTTP 200)
```

Developer exited code 1. Orchestrator went straight to BLOCKED — no retry.

### P0-3: Global `review-loop` linked to stale public repo — FIXED

`which review-loop` resolved to `/Users/dengyidong/Desktop/goal-review-loop-public/dist/` (old version without Phase 8F `network` schema). Config with `network` block was rejected.

**Fix applied**: `npm install -g .` from source repo reinstalled the current build.

### P0-4: Developer API empty response on long context (BLOCKING)

Claude (domestic API, `xopglm51` via 讯飞星火) returns `empty or malformed response (HTTP 200)` when Developer accumulates long context (reading source files + editing). This is a stable failure, not transient — the same prompt fails on retry.

**Root cause**: Domestic API cannot handle the context length that Developer accumulates over many turns of reading and editing source files.

**Partial fix applied**: Added Developer retry on `AGENT_ERROR` (`1be853a`). Retry triggers correctly but cannot solve stable context-length failures.

**Remaining**: Needs task decomposition (Phase 8B task graph) so each Developer run handles a smaller scope with shorter context. This is the next phase's goal.

## Round 3: Source repo with retry-enabled build (ysoj7w)

**Outcome**: BLOCKED at DEVELOPING — API empty response on both attempts

Planner succeeded. Developer first attempt failed with API empty response. Retry logic triggered correctly (`Starting Developer (iter 1 retry 1)` in progress). Second attempt also failed with same error. Both attempts did partial code edits before failing.

### P1-4: Developer retry works but cannot solve stable API failure

Retry mechanism (`1be853a`) verified working: progress shows `retry 1`, prompt file rebuilt, second attempt launched. However, the same long-context prompt fails both times.

### P1-5: BLOCKED is terminal — no resume

`review-loop resume` rejects BLOCKED runs: "already in terminal state: BLOCKED. Cannot resume." Developer's partial edits are lost. User must clean up and re-run from scratch.

**Impact**: Any transient Developer failure wastes the entire run including successful Planner output.

**Recommendation**: Consider making Developer-only failures non-terminal (retry within iteration loop, or allow resume from DEVELOPING).

## What worked

- `review-loop providers list` and `providers test` (health check) for codex and claude.
- Preflight git state detection, state creation, branch creation.
- Codex Planner via domestic gateway: generates high-quality plan and GOAL from real source code context.
- `-s workspace-write` fixes Planner write failures completely.
- Safe Claude argv launch (`sh -c` + `env -u` proxy strip + `--` separator): Developer receives prompt correctly and begins editing.
- Developer retry logic: triggers on `AGENT_ERROR`, rebuilds prompt file, re-launches.
- Watch mode, cancel, cleanup.

## Summary of fixes applied

| Issue | Status | Commit |
|-------|--------|--------|
| P0-1 Codex sandbox blocks writes | Fixed | `cd563ad` (review-loop.yaml) |
| P0-2 No safe default config | Fixed | `cd563ad` (review-loop.yaml) |
| P0-3 Stale global link | Fixed | `npm install -g .` |
| P0-4 Developer API empty response | Partial (retry) | `1be853a` |
| P1-1 TimeoutNaNWarning | Not fixed | — |
| P1-2 Misleading "completed" event | Not fixed | — |
| P1-3 test-report blocks preflight | Fixed | `df47a8a` |
| P1-5 BLOCKED is terminal | Not fixed | — |

## Conclusion

The plugin chain works end-to-end through PLANNING. Developer starts correctly with the safe launch config but cannot complete large tasks due to domestic API context-length limitations. This validates the need for Phase 8B task graph decomposition — smaller Developer tasks will keep context short enough for the domestic API to handle reliably.
