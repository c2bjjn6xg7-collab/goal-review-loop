# Phase 8F-R1 Fix Plan

## Source

- Requirements: `docs/phase-8f-r1-provider-launch-hardening.md`
- Test report: `docs/phase-8f-r1-plugin-test-report.md`
- Test runs: `8x5fle`, `48rdmu`, `ysoj7w`

## Objective

Fix the blocking and high-priority issues found when the Phase 8F-R1 requirements document was fed to the Review Loop plugin via `review-loop start --request-file`. The goal is to make a default `review-loop start` runnable end-to-end with Codex and Claude on this machine without hand-writing fragile shell snippets.

## Status Summary

| Fix | Priority | Status | Commit |
|-----|----------|--------|--------|
| FIX-1 Codex sandbox `-s workspace-write` | P0 | Applied via `review-loop.yaml` | `cd563ad` |
| FIX-2 Ship dogfood-safe `review-loop.yaml` | P0 | Applied | `cd563ad` |
| FIX-3 Fix `TimeoutNaNWarning` | P1 | Not started | — |
| FIX-4 Fix misleading "completed" progress event | P1 | Not started | — |
| FIX-5 Verify Planner artifact freshness | P1 | Not started | — |
| FIX-6 Developer retry on `AGENT_ERROR` | P0 | Applied | `1be853a` |
| FIX-7 `DEFAULT_CONFIG` still lacks `-s workspace-write` | P1 | Not started | — |

## Remaining Fixes

### FIX-3 (P1): Fix `TimeoutNaNWarning`

**Problem**: `TimeoutNaNWarning: NaN is not a number` at every run start.

**Files**: `src/runtime/process-runner.ts` (lines ~528, ~781), `src/agents/agent-adapter.ts` (line ~249)

**Root cause**: `timeout_ms` reaches `setTimeout` as NaN. Likely `undefined * 1000` in the config-to-agent-input chain.

**Fix**: Add NaN guards in `runProcess`/`runProcessRaw`:
```typescript
const timeoutMs = Number.isNaN(input.timeout_ms) || input.timeout_ms <= 0
  ? 30 * 60 * 1000
  : input.timeout_ms;
```
Also trace and fix the NaN source — ensure `timeout_seconds` is always a valid number from config.

**Test**: Unit test calling `runProcess` with `timeout_ms: NaN`, assert no throw.

---

### FIX-4 (P1): Fix misleading progress events

**Problem**: Orchestrator emits `'Planner completed'` (line ~423) and `'Developer completed'` (line ~879) unconditionally before checking success/failure. When the agent fails, progress briefly shows "completed" then transitions to BLOCKED.

**Files**: `src/orchestrator/run-orchestrator.ts` — lines ~420-445 (Planner), ~879-890 (Developer)

**Fix**: Move "completed" progress event to after the success check. Emit "failed" or "cancelled" for non-success statuses.

**Test**: Unit test with fake Planner exiting 0 but producing stale artifacts; assert progress never records "completed".

---

### FIX-5 (P1): Verify Planner artifact freshness catches stale files

**Problem**: `verifyArtifactFreshness` exists (`agent-adapter.ts` line ~397) but was not exercised to completion in tests. When Codex exits 0 without writing (sandbox block), the check should detect unchanged digests and report "stale".

**Files**: `src/agents/agent-adapter.ts` (lines ~323-410), `src/agents/planner-adapter.ts` (line ~40)

**Fix**: No code change needed if the check works. Add a dedicated integration test: pre-existing `.agent/plan.md` + fake Planner exits 0 without modifying → assert `runAgent` returns `failed` with `ARTIFACT_ERROR` "stale".

---

### FIX-7 (P1): Fix `DEFAULT_CONFIG` Codex commands

**Problem**: `DEFAULT_CONFIG` in `src/artifacts/config.ts` and `builtin-providers.ts` still lack `-s workspace-write`. The shipped `review-loop.yaml` masks this for this repo, but any other repo without a config file will hit P0-1.

**Files**: `src/artifacts/config.ts` (`DEFAULT_CONFIG` ~line 148), `src/providers/builtin-providers.ts` (codex ~line 29)

**Fix**: Add `-s workspace-write` to all Codex commands in `DEFAULT_CONFIG` and the builtin codex profile.

**Test**: Unit test asserting `DEFAULT_CONFIG.agents.planner.command` contains `'-s'` and `'workspace-write'`.

## Already Applied

### FIX-1 + FIX-2: `review-loop.yaml` with safe defaults (commit `cd563ad`)

Created `review-loop.yaml` with:
- Codex agents: `-s workspace-write`
- Claude developer: `sh -c` non-login + `env -u` proxy strip + `--` separator + argv prompt
- Provider network: claude `none`, codex `inherit`

### FIX-6: Developer retry on AGENT_ERROR (commit `1be853a`)

Added retry loop in `runIterationLoop`: when Developer fails with `AGENT_ERROR`, automatically retry once with rebuilt prompt file. Verified working — progress shows `retry 1`. Cannot solve stable API context-length failures but handles transient issues.

## Verification (after remaining fixes)

1. `npm run typecheck`
2. `npm run lint`
3. `npm run build`
4. `npm test`
5. `npm audit --omit=dev`
6. `npm pack --dry-run`
7. `git diff --check`
8. No `TimeoutNaNWarning` in `review-loop start`
