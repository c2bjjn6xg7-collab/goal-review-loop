# Phase 8D P6 Round 2 Failure Guard Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Round 1 failure-guard pure helpers into the single-goal iteration loop so that repeated soft failures trip a run-level circuit breaker (`CONSECUTIVE_FAILURE_LIMIT`) before the iteration budget is exhausted.

**Architecture:** One new orchestrator-layer helper module (`src/orchestrator/failure-guard.ts`) wraps the Round 1 pure functions with `StateStore` side effects. The single-goal `runIterationLoop` gains: (a) one loop-top early-exit gate after the cancel check, (b) one `recordSoftFailure` call before each of four `continue` rework branches, (c) one `recordSoftFailurePass` call on Auditor PASS. Task-graph mode is untouched.

**Tech Stack:** TypeScript, existing `StateStore`, Ajv schemas, Vitest, existing `fake-agent.mjs` fixture.

**Authoritative spec:** `docs/superpowers/specs/2026-06-19-phase-8d-p6-round2-failure-guard-wiring-design.md`. Read it first; this plan is the executable breakdown.

---

## Scope

**In scope**

- New `src/orchestrator/failure-guard.ts` with `recordSoftFailure` / `recordSoftFailurePass` and unit tests.
- Add `ErrorCategory.CONSECUTIVE_FAILURE_LIMIT` + `ERROR_CATEGORY_DEFAULT_RESULT` mapping.
- Wire the loop-top gate, four soft-failure inserts, and PASS reset into `runIterationLoop`.
- Integration tests I1/I2/I3 + error-normalization test updates.

**Out of scope (deferred to Round 3)**

- task-graph mode (`task-graph-loop.ts`).
- `max_agent_retries` / escalation.
- `status` / `progress.md` surfacing.
- `last_failure_class` field.
- `docs/configuration.md`.
- Wiring the reserved `developer_blocked` / `infrastructure_error` classes.

---

## Files

**Modify:**
- `src/types.ts` — `ErrorCategory` + `ERROR_CATEGORY_DEFAULT_RESULT`.
- `src/orchestrator/run-orchestrator.ts` — loop-top gate, 4 inserts, PASS reset.
- `tests/integration/run-orchestrator.test.ts` — `writeFakeAgentConfig` loop override + I1/I2/I3.
- `tests/unit/error-normalization.test.ts` — 21→22, new assertion.

**Create:**
- `src/orchestrator/failure-guard.ts`
- `tests/unit/failure-guard.test.ts`

**Do not touch:**
- `src/scheduler/failure-policy.ts` (Round 1, stable).
- `src/orchestrator/task-graph-loop.ts`.
- `src/orchestrator/state-store.ts` (Round 1 added the field).
- `src/artifacts/config.ts` (Round 1 added the config keys).
- `src/cli/**`, `src/runtime/progress-writer.ts`, `prompts/**`, `.agent/**`.

---

## Data Contract Reminders (from Round 1, already shipped)

- `RunState.consecutive_failure_count: number` — required integer ≥ 0, initialized to 0 by `buildInitialState`, persisted across resume via `stateStore.read()`.
- `config.loop.max_consecutive_failures: number` — integer 1..10, default 3.
- Pure helpers in `src/scheduler/failure-policy.ts`:
  - `recordFailureGuardFailure({ consecutiveFailureCount, maxConsecutiveFailures, failureClass })` → `{ consecutiveFailureCount, thresholdReached, errorCode, message }`. `thresholdReached = (count+1) >= max`.
  - `recordFailureGuardPass({ consecutiveFailureCount, maxConsecutiveFailures })` → count 0, thresholdReached false.
  - Throws `FailurePolicyError` on invalid inputs.
- `StateStore.update(updater)` returns the new `RunState` (callers can read the written count from the return value).
- `StateStore.buildInitialState({ run_id, task_slug, project_root, base_commit, branch, max_iterations })` returns a `RunState` without persisting.

---

## Task 1: Add `CONSECUTIVE_FAILURE_LIMIT` Error Category

**Files:**
- Modify: `src/types.ts:184` (ErrorCategory), `src/types.ts:213` (ERROR_CATEGORY_DEFAULT_RESULT)
- Modify: `tests/unit/error-normalization.test.ts:13`, add assertion

- [ ] **Step 1: Write the failing test**

In `tests/unit/error-normalization.test.ts`, first update the count assertion and add a mapping assertion. Change `:13`:

```ts
  it('has exactly 21 error categories', () => {
    expect(allCategories).toHaveLength(21);
  });
```
to:
```ts
  it('has exactly 22 error categories', () => {
    expect(allCategories).toHaveLength(22);
  });
```

Then add a new test block inside the `describe('Error normalization', ...)` block, after the `USER_CANCELLED` mapping test (`:69-71`):

```ts
  it('CONSECUTIVE_FAILURE_LIMIT maps to FAILED phase', () => {
    expect(ERROR_CATEGORY_DEFAULT_RESULT.get(ErrorCategory.CONSECUTIVE_FAILURE_LIMIT)).toBe('FAILED');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/unit/error-normalization.test.ts`
Expected: FAIL — `toHaveLength(22)` fails (currently 21), and `ErrorCategory.CONSECUTIVE_FAILURE_LIMIT` is `undefined`. The guard test (`:17-21` "every error category has a default result phase") may also fail once the category is added without the map entry — that is expected and will be fixed in Step 3.

- [ ] **Step 3: Add the error category and mapping**

In `src/types.ts`, extend `ErrorCategory` (add after `INFRASTRUCTURE_ERROR: 'INFRASTRUCTURE_ERROR',` at `:205`):

```ts
  INFRASTRUCTURE_ERROR: 'INFRASTRUCTURE_ERROR',
  CONSECUTIVE_FAILURE_LIMIT: 'CONSECUTIVE_FAILURE_LIMIT',
} as const;
```

In `src/types.ts`, extend `ERROR_CATEGORY_DEFAULT_RESULT` (add after the `[ErrorCategory.INFRASTRUCTURE_ERROR, Phase.BLOCKED],` line at `:234`):

```ts
  [ErrorCategory.INFRASTRUCTURE_ERROR, Phase.BLOCKED],
  [ErrorCategory.CONSECUTIVE_FAILURE_LIMIT, Phase.FAILED],
]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/unit/error-normalization.test.ts`
Expected: PASS — all tests including the new count (22) and the new mapping assertion.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/unit/error-normalization.test.ts
git commit -m "feat(phase-8d/p6): add CONSECUTIVE_FAILURE_LIMIT error category"
```

---

## Task 2: Create `failure-guard.ts` Helper (TDD)

**Files:**
- Create: `src/orchestrator/failure-guard.ts`
- Create: `tests/unit/failure-guard.test.ts`

This helper is a thin orchestrator-layer wrapper around the Round 1 pure helpers. It reads state, computes via the pure function, persists via `StateStore.update`. It does **not** transition phase, build `OrchestratorResult`, write logs, or catch exceptions — `FailurePolicyError` from the pure layer passes through unchanged.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/failure-guard.test.ts`:

```ts
/**
 * Phase 8D P6 Round 2: unit tests for the failure-guard orchestrator helper.
 * Uses a real StateStore against a temp state.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../../src/orchestrator/state-store.js';
import { recordSoftFailure, recordSoftFailurePass } from '../../src/orchestrator/failure-guard.js';
import { Phase as PhaseEnum, type ReviewLoopConfig, type FailureClass } from '../../src/types.js';

function makeConfig(maxConsecutiveFailures: number): ReviewLoopConfig {
  return {
    version: 1,
    agents: {},
    loop: {
      max_iterations: 5,
      archive_history: true,
      stop_on_infrastructure_error: true,
      max_consecutive_failures: maxConsecutiveFailures,
      max_agent_retries: 1,
    },
    git: {
      require_repository: false,
      require_head: false,
      require_clean_worktree: false,
      branch_template: 'agent/{run_id}-{task_slug}',
      commit_on_pass: false,
      commit_template: '',
      create_tag: false,
      tag_template: '',
      push: false,
    },
    runtime: {
      kill_grace_seconds: 5,
      max_log_bytes: 10485760,
      lock_stale_seconds: 86400,
    },
  } as unknown as ReviewLoopConfig;
}

describe('failure-guard helper', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(async () => {
    dir = join(tmpdir(), `fg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    store = new StateStore(dir);
    await store.create({
      run_id: 'run-test',
      task_slug: 'test',
      project_root: dir,
      base_commit: 'abc123',
      branch: 'main',
      max_iterations: 5,
    });
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch { /* ok */ }
  });

  it('H1: recordSoftFailure increments from 0 to 1', async () => {
    const outcome = await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    expect(outcome.consecutiveFailureCount).toBe(1);
    const state = await store.read();
    expect(state.consecutive_failure_count).toBe(1);
  });

  it('H2: persists across calls (second call reads first call value)', async () => {
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    const outcome = await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    expect(outcome.consecutiveFailureCount).toBe(2);
    const state = await store.read();
    expect(state.consecutive_failure_count).toBe(2);
  });

  it('H3: thresholdReached true when reaching max (2 -> 3, max=3)', async () => {
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    const outcome = await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    expect(outcome.thresholdReached).toBe(true);
    expect(outcome.consecutiveFailureCount).toBe(3);
  });

  it('H4: thresholdReached false below max (1 -> 2, max=3)', async () => {
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    const outcome = await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    expect(outcome.thresholdReached).toBe(false);
    expect(outcome.consecutiveFailureCount).toBe(2);
  });

  it('H5: recordSoftFailurePass resets count to 0', async () => {
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    const outcome = await recordSoftFailurePass(store, makeConfig(3));
    expect(outcome.consecutiveFailureCount).toBe(0);
    const state = await store.read();
    expect(state.consecutive_failure_count).toBe(0);
  });

  it('H6: no other state fields touched except consecutive_failure_count and updated_at', async () => {
    const before = await store.read();
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    const after = await store.read();
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      if (key === 'consecutive_failure_count' || key === 'updated_at') continue;
      expect(after[key]).toEqual(before[key]);
    }
  });

  it('H7: all four FailureClass values accepted', async () => {
    const classes: FailureClass[] = ['auditor_block', 'developer_blocked', 'verification_failed', 'infrastructure_error'];
    let expected = 0;
    for (const cls of classes) {
      expected += 1;
      const outcome = await recordSoftFailure(store, makeConfig(10), cls);
      expect(outcome.consecutiveFailureCount).toBe(expected);
    }
    const state = await store.read();
    expect(state.consecutive_failure_count).toBe(4);
  });
});
```

> **Note on `FailureClass` import:** Round 1 declared `FailureClass` in `src/scheduler/failure-policy.ts`. If `FailureClass` is not re-exported from `src/types.ts`, import it from `'../../src/scheduler/failure-policy.js'` instead. Check during implementation and adjust the import path; the test logic is unchanged either way.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/unit/failure-guard.test.ts`
Expected: FAIL — module `../../src/orchestrator/failure-guard.js` not found.

- [ ] **Step 3: Implement the helper**

Create `src/orchestrator/failure-guard.ts`:

```ts
/**
 * Phase 8D P6 Round 2: orchestrator-layer failure guard.
 *
 * Thin wrapper around the Round 1 pure helpers (src/scheduler/failure-policy.ts).
 * Reads state, computes the next count via the pure function, persists via
 * StateStore.update. This module has side effects (state.json writes) and lives
 * in orchestrator/, distinct from the pure scheduler/ helper.
 *
 * Responsibility boundary:
 *   - Does: read count, compute next, persist, return outcome.
 *   - Does NOT: transition phase, build OrchestratorResult, write iteration-log,
 *     or catch exceptions. FailurePolicyError from the pure layer is re-thrown
 *     unchanged so callers see invalid-config / invalid-state as hard failures.
 *
 * The early-exit decision is NOT made here. `thresholdReached` in the returned
 * outcome is for logging and test observability only. The actual FAILED
 * transition happens at the single loop-top gate in runIterationLoop.
 */

import type { StateStore } from './state-store.js';
import type { ReviewLoopConfig } from '../types.js';
import {
  recordFailureGuardFailure,
  recordFailureGuardPass,
  type FailureClass,
} from '../scheduler/failure-policy.js';

export interface FailureGuardOutcome {
  /** New count after this update, persisted to state.json. */
  consecutiveFailureCount: number;
  /** True iff THIS update reached the threshold.
   *  Observability only — the early-exit gate lives at the loop top. */
  thresholdReached: boolean;
}

/**
 * Record a tracked soft-failure. Increments the run-level counter and persists
 * it. The caller continues to the next iteration; the loop-top gate performs
 * the FAILED transition when the threshold has been reached.
 *
 * Does not catch exceptions. `FailurePolicyError` (invalid count / invalid
 * threshold / invalid failureClass) propagates to the caller.
 */
export async function recordSoftFailure(
  stateStore: StateStore,
  config: ReviewLoopConfig,
  failureClass: FailureClass,
): Promise<FailureGuardOutcome> {
  const current = await stateStore.read();
  const pure = recordFailureGuardFailure({
    consecutiveFailureCount: current.consecutive_failure_count,
    maxConsecutiveFailures: config.loop.max_consecutive_failures,
    failureClass,
  });
  await stateStore.update(() => ({
    consecutive_failure_count: pure.consecutiveFailureCount,
  }));
  return {
    consecutiveFailureCount: pure.consecutiveFailureCount,
    thresholdReached: pure.thresholdReached,
  };
}

/**
 * Reset the run-level counter on a passing iteration (Auditor PASS entering
 * FINALIZING). Always writes 0 — no read-then-skip optimization; the extra
 * state.json write is trivial and the simpler logic is preferable.
 *
 * Does not catch exceptions.
 */
export async function recordSoftFailurePass(
  stateStore: StateStore,
  config: ReviewLoopConfig,
): Promise<FailureGuardOutcome> {
  const current = await stateStore.read();
  const pure = recordFailureGuardPass({
    consecutiveFailureCount: current.consecutive_failure_count,
    maxConsecutiveFailures: config.loop.max_consecutive_failures,
  });
  await stateStore.update(() => ({
    consecutive_failure_count: pure.consecutiveFailureCount,
  }));
  return {
    consecutiveFailureCount: pure.consecutiveFailureCount,
    thresholdReached: pure.thresholdReached,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/unit/failure-guard.test.ts`
Expected: PASS — all 7 cases (H1–H7).

- [ ] **Step 5: Run typecheck and lint**

Run: `npm run typecheck && npm run lint -- --max-warnings 0`
Expected: PASS. (Adjust the `FailureClass` import path in both files if the typecheck reports it is not exported from `src/types.ts`.)

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/failure-guard.ts tests/unit/failure-guard.test.ts
git commit -m "feat(phase-8d/p6): add failure-guard orchestrator helper"
```

---

## Task 3: Wire the Loop-Top Circuit-Breaker Gate

**Files:**
- Modify: `src/orchestrator/run-orchestrator.ts` (inside `runIterationLoop`, after the cancel check ~`:757-769`, before DEVELOPING ~`:771`)

This is the single early-exit point. It runs on every iteration (including the first resume iteration), after the cancel check (cancel has priority) and before any iteration work begins.

- [ ] **Step 1: Add the import**

At the top of `src/orchestrator/run-orchestrator.ts`, add the helper import near the other orchestrator imports:

```ts
import { recordSoftFailure, recordSoftFailurePass } from './failure-guard.js';
```

- [ ] **Step 2: Insert the gate**

In `runIterationLoop`, the loop currently starts (around `:756-769`):

```ts
  for (let iteration = startIteration; iteration <= maxIterations; iteration++) {
    // ── Cancel check at top of iteration ──
    const cancelReq = await checkCancelRequest(agentDir);
    if (cancelReq) {
      await stateStore.update(() => ({ cancel_requested_at: cancelReq.requested_at }));
      await stateStore.transition(PhaseEnum.CANCELLED);
      await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'cancel requested', 'CANCELLED');
      return makeResult(
        runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [],
        'Run cancelled by user request',
        `Cancel requested at ${cancelReq.requested_at}`,
        null,
      );
    }

    // ── DEVELOPING (or REWORKING for iteration > 1) ──
```

Insert the gate between the cancel block's closing `}` and the `// ── DEVELOPING` comment:

```ts
    }

    // Phase 8D P6: run-level circuit breaker. Cancel takes priority; this gate
    // runs before any iteration work begins.
    const breakerState = await stateStore.read();
    if (breakerState.consecutive_failure_count >= config.loop.max_consecutive_failures) {
      const count = breakerState.consecutive_failure_count;
      const max = config.loop.max_consecutive_failures;
      await stateStore.transition(PhaseEnum.FAILED);
      await appendLog(
        artifactStore, runId, iteration,
        breakerState.phase, 'circuit breaker tripped', 'FAIL',
        `consecutive_failure_count=${count}/${max}`,
      );
      return makeResult(
        runId, PhaseEnum.FAILED, 2, currentBranch, null, [],
        'Consecutive failure limit reached',
        `Consecutive soft failures reached ${count}/${max}. Review .agent/iteration-log.md for failure details.`,
        {
          code: 'CONSECUTIVE_FAILURE_LIMIT',
          message: `Consecutive soft failures reached ${count}/${max}. Review .agent/iteration-log.md for failure details.`,
          resumable: false,
          suggested_action: 'Review .agent/iteration-log.md, adjust GOAL/prompts/config, then start a new run',
        },
      );
    }

    // ── DEVELOPING (or REWORKING for iteration > 1) ──
```

> **Why `>=`:** matches the Round 1 pure helper (`thresholdReached = nextCount >= max`). Why `breakerState.phase` in the log: at trip time the phase is typically `REWORKING` (set by the prior soft failure); hardcoding `DEVELOPING` would mislead the log.

- [ ] **Step 3: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS. (The gate references `PhaseEnum.FAILED`, `makeResult`, `appendLog`, `stateStore`, `artifactStore`, `runId`, `iteration`, `currentBranch`, `config` — all in scope inside `runIterationLoop`.)

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/run-orchestrator.ts
git commit -m "feat(phase-8d/p6): add loop-top circuit-breaker gate"
```

---

## Task 4: Wire the Four Soft-Failure Inserts

**Files:**
- Modify: `src/orchestrator/run-orchestrator.ts` — four `continue` branches

Each insert goes **before** the `if (iteration >= maxIterations)` check within its branch, so the last failure coinciding with exhaustion still counts (resume sees an accurate count). Comment style: one line, no banner.

- [ ] **Step 1: Insert #1 — scope violation (`verification_failed`)**

Find the scope-violation branch (around `:1132-1148`):

```ts
    if (!scopeResult.passed) {
      await stateStore.transition(PhaseEnum.REWORKING);
      const deniedPaths = scopeResult.report.denied.map(d => d.path).join(', ');
      await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'scope result', 'FAIL', `Denied: ${deniedPaths}`);

      if (iteration >= maxIterations) {
```

Insert the record call after the `appendLog(...)` line and before `if (iteration >= maxIterations)`:

```ts
      await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'scope result', 'FAIL', `Denied: ${deniedPaths}`);

      // Phase 8D P6: track soft failure before rework/terminal handling.
      await recordSoftFailure(stateStore, config, 'verification_failed');

      if (iteration >= maxIterations) {
```

- [ ] **Step 2: Insert #2 — verification command failure (`verification_failed`)**

Find the verification-failure branch (around `:1178-1196`):

```ts
    if (!requiredPassed) {
      await stateStore.transition(PhaseEnum.REWORKING);
      const failedCmds = verificationResult.manifest.commands
        .filter(c => c.required && c.status !== 'success')
        .map(c => c.id);
      await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'verification result', 'FAIL', `Failed: ${failedCmds.join(', ')}`);

      if (iteration >= maxIterations) {
```

Insert after the `appendLog(...)` line:

```ts
      await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'verification result', 'FAIL', `Failed: ${failedCmds.join(', ')}`);

      // Phase 8D P6: track soft failure before rework/terminal handling.
      await recordSoftFailure(stateStore, config, 'verification_failed');

      if (iteration >= maxIterations) {
```

- [ ] **Step 3: Insert #3 — mechanical override Auditor PASS (`verification_failed`)**

Find the mechanical-override branch (around `:1428-1444`):

```ts
    if (!auditValidation.valid) {
      if (auditValidation.decision === 'PASS') {
        await stateStore.transition(PhaseEnum.REWORKING);
        await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'FAIL', `Mechanical check failure overrides PASS: ${auditValidation.errors.join('; ')}`);

        if (iteration >= maxIterations) {
```

Insert after the `appendLog(...)` line:

```ts
        await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'FAIL', `Mechanical check failure overrides PASS: ${auditValidation.errors.join('; ')}`);

        // Phase 8D P6: track soft failure before rework/terminal handling.
        await recordSoftFailure(stateStore, config, 'verification_failed');

        if (iteration >= maxIterations) {
```

- [ ] **Step 4: Insert #4 — Auditor FAIL (`auditor_block`)**

Find the Auditor FAIL branch (around `:1484-1499`):

```ts
    if (decision === 'FAIL') {
      await stateStore.transition(PhaseEnum.REWORKING);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'FAIL');

      if (iteration >= maxIterations) {
```

Insert after the `appendLog(...)` line:

```ts
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'FAIL');

      // Phase 8D P6: track soft failure before rework/terminal handling.
      await recordSoftFailure(stateStore, config, 'auditor_block');

      if (iteration >= maxIterations) {
```

- [ ] **Step 5: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/run-orchestrator.ts
git commit -m "feat(phase-8d/p6): track soft failures at four rework branches"
```

---

## Task 5: Wire the PASS Reset

**Files:**
- Modify: `src/orchestrator/run-orchestrator.ts` — Auditor PASS branch (`:1452`)

The reset goes after `transition(FINALIZING)` + `appendLog(PASS)`, before `dispatchFeedbackBlocks`. Not wrapped in try/catch — a `stateStore.update()` failure is an infrastructure fault that must not be swallowed (it would leave "finalization proceeded but counter not reset" inconsistency).

- [ ] **Step 1: Insert the reset**

Find the Auditor PASS branch (around `:1452-1461`):

```ts
    if (decision === 'PASS') {
      await stateStore.transition(PhaseEnum.FINALIZING);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'PASS');
      // Phase 10: dispatch ReviewLoopRequest feedback blocks from audit-report.md (best-effort).
      await dispatchFeedbackBlocks({
```

Insert the reset call between the `appendLog(...)` line and the Phase 10 comment:

```ts
    if (decision === 'PASS') {
      await stateStore.transition(PhaseEnum.FINALIZING);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'PASS');

      // Phase 8D P6: passing iteration resets the run-level failure counter.
      await recordSoftFailurePass(stateStore, config);

      // Phase 10: dispatch ReviewLoopRequest feedback blocks from audit-report.md (best-effort).
      await dispatchFeedbackBlocks({
```

- [ ] **Step 2: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 3: Run the full unit suite to confirm no regressions**

Run: `npm test -- --run`
Expected: PASS — all existing tests green (the new gate does not fire under defaults because `consecutive_failure_count` starts at 0 and existing tests do not configure the counter to trip).

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/run-orchestrator.ts
git commit -m "feat(phase-8d/p6): reset failure counter on auditor PASS"
```

---

## Task 6: Extend `writeFakeAgentConfig` for Loop Overrides + Add Integration Tests

**Files:**
- Modify: `tests/integration/run-orchestrator.test.ts` — `writeFakeAgentConfig` signature + I1/I2/I3

`writeFakeAgentConfig` currently hardcodes `loop: { max_iterations: 3 }` (`:39`). It must accept a loop override so I1 can set `max_consecutive_failures: 2, max_iterations: 5`.

- [ ] **Step 1: Add the loop override to `writeFakeAgentConfig`**

Change the function signature (around `:16`):

```ts
function writeFakeAgentConfig(repoDir: string, roleBehaviors: Record<string, string>): void {
```
to:
```ts
function writeFakeAgentConfig(
  repoDir: string,
  roleBehaviors: Record<string, string>,
  loopOverrides: Record<string, unknown> = {},
): void {
```

Change the `loop:` field in the config object (around `:39`):

```ts
    loop: { max_iterations: 3 },
```
to:
```ts
    loop: { max_iterations: 3, ...loopOverrides },
```

Then update `createTestRepo` to thread the override through. Change its signature (around `:75`):

```ts
function createTestRepo(suffix: string, roleBehaviors: Record<string, string> = {}): string {
```
to:
```ts
function createTestRepo(
  suffix: string,
  roleBehaviors: Record<string, string> = {},
  loopOverrides: Record<string, unknown> = {},
): string {
```

And change the `writeFakeAgentConfig(repoDir, roleBehaviors);` call inside it (around `:97`):

```ts
  writeFakeAgentConfig(repoDir, roleBehaviors);
```
to:
```ts
  writeFakeAgentConfig(repoDir, roleBehaviors, loopOverrides);
```

> **Backward compatibility:** existing callers pass no third arg, so `loopOverrides = {}` and the spread is a no-op. No existing test changes behavior.

- [ ] **Step 2: Write the three integration tests**

Add these inside the `describe('Run Orchestrator integration', ...)` block. Place them near the other failure-related scenarios (e.g. after the timeout scenario around `:241`).

```ts
  // ─── Phase 8D P6 Round 2: circuit breaker ────────────────────

  it('I1: trips CONSECUTIVE_FAILURE_LIMIT before iteration exhaustion', async () => {
    repoDir = createTestRepo(
      'breaker-trip',
      { auditor: 'audit-fail' },
      { max_consecutive_failures: 2, max_iterations: 5 },
    );

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a feature',
      task_slug: 'breaker-trip',
    });

    expect(result.phase).toBe('FAILED');
    expect(result.exit_code).toBe(2);
    expect(result.error?.code).toBe('CONSECUTIVE_FAILURE_LIMIT');

    const state = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
    expect(state.consecutive_failure_count).toBe(2);
  });

  it('I2: PASS resets the counter, no breaker trip', async () => {
    repoDir = createTestRepo(
      'breaker-reset',
      { auditor: 'audit-fail-then-pass' },
      { max_consecutive_failures: 3, max_iterations: 3 },
    );

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a feature',
      task_slug: 'breaker-reset',
    });

    expect(result.phase).toBe('PASSED');
    expect(result.error?.code).not.toBe('CONSECUTIVE_FAILURE_LIMIT');

    const state = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
    expect(state.consecutive_failure_count).toBe(0);
  });

  it('I3: same-iteration exhaustion preempts the loop-top gate', async () => {
    repoDir = createTestRepo(
      'breaker-inert',
      { auditor: 'audit-fail' },
      { max_consecutive_failures: 3, max_iterations: 3 },
    );

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a feature',
      task_slug: 'breaker-inert',
    });

    expect(result.phase).toBe('FAILED');
    // Breaker did NOT trip: same-iteration maxIterations exhaustion returned first.
    expect(result.error?.code).not.toBe('CONSECUTIVE_FAILURE_LIMIT');
  });
```

- [ ] **Step 3: Run the integration tests**

Run: `npm test -- --run tests/integration/run-orchestrator.test.ts`
Expected: PASS — I1 trips the breaker (count reaches 2 on iteration 2's Auditor FAIL; loop-top gate fires on iteration 3), I2 resets and passes, I3 exhausts iterations without the breaker code.

> **If I1 fails with the breaker not tripping:** confirm `audit-fail` in `tests/fixtures/fake-agent.mjs` returns FAIL on every iteration (it does — verified at `fake-agent.mjs:680`). Confirm the loop override reached the config: `cat <repoDir>/review-loop.yaml` is not possible post-run (repo is cleaned up), so add a temporary `console.log` in `writeFakeAgentConfig` if debugging is needed, then remove it.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/run-orchestrator.test.ts
git commit -m "test(phase-8d/p6): circuit-breaker integration scenarios"
```

---

## Task 7: Full Gate Run

**Files:** None (verification only).

- [ ] **Step 1: Run all engineering gates**

Run each in order:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

Expected: all PASS. Round 1 baseline was 1018 passed / 66 files; Round 2 adds `failure-guard.test.ts` (7 cases) + I1/I2/I3 + 1 modified normalization assertion. The total should rise accordingly with zero failures.

- [ ] **Step 2: Confirm task-graph mode is untouched**

Run: `git diff main -- src/orchestrator/task-graph-loop.ts`
Expected: empty (no changes to task-graph mode).

- [ ] **Step 3: Confirm scope-guard files are untouched**

Run: `git diff main -- src/scheduler/failure-policy.ts src/orchestrator/state-store.ts src/artifacts/config.ts src/cli/ src/runtime/progress-writer.ts`
Expected: empty.

- [ ] **Step 4: No commit (verification only)**

If all gates pass and the diffs are empty where expected, Round 2 is complete. The implementation commits were made per-task; no final commit is needed.

---

## Acceptance Criteria

- `ErrorCategory.CONSECUTIVE_FAILURE_LIMIT` exists and maps to `Phase.FAILED`.
- `error-normalization.test.ts` count assertion is 22; new mapping assertion passes.
- `src/orchestrator/failure-guard.ts` exists with `recordSoftFailure` / `recordSoftFailurePass`; unit tests H1–H7 pass.
- Loop-top gate in `runIterationLoop` fires `FAILED` + `CONSECUTIVE_FAILURE_LIMIT` when `consecutive_failure_count >= max_consecutive_failures`, after the cancel check.
- Four soft-failure branches (`:1132`, `:1178`, `:1428`, `:1484`) call `recordSoftFailure` before their `if (iteration >= maxIterations)` check.
- Auditor PASS branch calls `recordSoftFailurePass` before `dispatchFeedbackBlocks`.
- I1 trips the breaker; I2 resets and passes; I3 exhausts iterations without the breaker code.
- `task-graph-loop.ts`, `failure-policy.ts`, `state-store.ts`, `config.ts`, `cli/`, `progress-writer.ts`, `prompts/` are unchanged.
- All four engineering gates pass.

---

## Explicit Non-Goals (deferred to Round 3)

- task-graph mode counter wiring.
- `max_agent_retries` / same-provider retry budget.
- `escalation_target` provider upgrade.
- `review-loop status` and `.agent/progress.md` surfacing.
- `last_failure_class` field.
- `docs/configuration.md`.
- Wiring `developer_blocked` / `infrastructure_error` (kept as enum values, no call sites).
