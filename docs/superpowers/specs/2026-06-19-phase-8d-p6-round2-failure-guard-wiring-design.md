# Phase 8D P6 Round 2: Failure Guard Wiring — Design Spec

> **Status:** Approved (7/7 design sections agreed with user, 2026-06-19)
> **Predecessor:** Round 1 foundation (`commit 14ed2f2`) — config keys, state field, pure helper.
> **Successor:** Round 3 — `max_agent_retries` / escalation / task-graph wiring.

## Goal

Wire the Round 1 failure-guard foundation into the **single-goal iteration loop**
so that repeated soft failures trip a run-level circuit breaker before the
iteration budget is exhausted.

## Scope Summary

Round 2 connects the pure `failure-policy.ts` helpers (Round 1) to real soft-failure
paths in `runIterationLoop`. It adds one orchestrator-layer helper module, inserts
counter updates at four soft-failure `continue` branches plus the PASS reset, and
installs a single early-exit gate at the top of the iteration loop.

**Task-graph mode is out of scope.** The counter is read/written only by the
single-goal iteration loop. See "Non-Goals".

---

## Key Design Decisions (locked with user)

### D1. Circuit-breaker early exit lands in `Phase.FAILED`, not `Phase.BLOCKED`

The original design doc (`docs/phase-8d-consecutive-failure-guard.md` §3) said the
breaker exits into `BLOCKED`. **This spec corrects that.** Rationale:

- The breaker is "soft failures repeated too many times" — an accelerated form of
  budget exhaustion, the same family as `iteration >= maxIterations`.
- Existing code (`run-orchestrator.ts:1138,1186,1434,1489`) already defines
  soft-failure budget exhaustion as `Phase.FAILED`.
- `BLOCKED` is reserved for hard faults needing user intervention (Developer
  anomalies, state conflicts). The breaker is not that.

Consequence: `ErrorCategory.CONSECUTIVE_FAILURE_LIMIT` maps to `Phase.FAILED` in
`ERROR_CATEGORY_DEFAULT_RESULT`, alongside `VERIFICATION_FAILED` / `AUDIT_FAILED` /
`SCOPE_VIOLATION`.

### D2. Resume inherits the counter; new runs start at 0

`consecutive_failure_count` is run-level state. Resume continues the same run, so
it inherits the persisted count. A new `start` calls `buildInitialState`, which
sets the counter to 0.

### D3. The counter is aggregated across soft-failure types, not per-class

The count increments on **any** tracked soft failure, regardless of class. The
early-exit message therefore does **not** name a specific failure class — reporting
"the last class" would mislead (failures may alternate). The message points to
`.agent/iteration-log.md` instead. No `last_failure_class` field is added (keeps
the Round 1 state contract unchanged).

### D4. Single early-exit gate at the loop top, not per-branch

The helper returns `thresholdReached` for logging/test observability only. The
actual early-exit is a single `if` at the top of the iteration loop, after the
cancel check. Cancel priority > breaker priority > iteration work.

---

## Tracked Soft-Failure Points

Only `REWORKING + continue` branches in `runIterationLoop` are counted. Hard
`return` terminations (Developer BLOCKED, ARTIFACT_ERROR, etc.) are excluded.

| # | Location (run-orchestrator.ts) | Failure | `failureClass` |
|---|---|---|---|
| 1 | `:1132` scope violation → REWORKING | scope check fails in VERIFYING | `verification_failed` |
| 2 | `:1178` verification command → REWORKING | required cmd fails | `verification_failed` |
| 3 | `:1428` mechanical override Auditor PASS → REWORKING | mechanical check vetoes PASS | `verification_failed` |
| 4 | `:1484` Auditor FAIL → REWORKING | Auditor decision FAIL | `auditor_block` |

**Mapping rationale:**

- #1/#2/#3 → `verification_failed`: all occur in VERIFYING-class checks and trigger
  rework. No new `scope_violation` class is added (keeps Round 1 contract).
- #3 specifically: Auditor did not say FAIL; the mechanical validator rejected the
  Auditor's PASS. `verification_failed` is more accurate than `auditor_block`.
- #4 → `auditor_block`: the Auditor itself blocked passage by returning FAIL. This
  is "auditor blocked passing," distinct from phase-level `BLOCKED`.

**Excluded (hard terminations, return not continue):** `:793` archive idempotency,
`:1002/1008` Developer no result, `:1035` Developer exec failure, `:1050` Developer
tamper, `:1074` Developer reported BLOCKED (hard return — explicitly out this round),
`:1447` Auditor output invalid, `:1502` Auditor returned BLOCKED.

**Excluded (budget exhaustion):** `:1137/1185/1433/1488` `iteration >= maxIterations`
branches — these are terminal `return`, not `continue`.

**Insertion order:** `recordSoftFailure(...)` goes **before** the
`if (iteration >= maxIterations)` check within each branch. The last failure that
coincides with exhaustion still counts — resume must see an accurate count.

---

## Components

### New file: `src/orchestrator/failure-guard.ts`

Thin orchestrator-layer wrapper around the Round 1 pure helpers. Reads state,
computes via pure function, persists. Does **not** transition phase, does **not**
build `OrchestratorResult`, does **not** write logs, does **not** throw on
input errors (passes through `FailurePolicyError` from the pure layer).

```ts
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
 * Phase 8D P6 Round 2: record a tracked soft-failure. Reads current count,
 * computes next via the pure Round 1 helper, persists it. Does NOT exit the
 * loop; the caller continues, and the loop-top gate performs FAILED.
 */
export async function recordSoftFailure(
  stateStore: StateStore,
  config: ReviewLoopConfig,
  failureClass: FailureClass,
): Promise<FailureGuardOutcome>;

/**
 * Phase 8D P6 Round 2: reset the counter on a passing iteration
 * (Auditor PASS entering FINALIZING). Persists count = 0.
 *
 * No read-then-skip optimization: always writes 0. Simplicity over sparing
 * a trivial state.json write.
 */
export async function recordSoftFailurePass(
  stateStore: StateStore,
  config: ReviewLoopConfig,
): Promise<FailureGuardOutcome>;
```

**Responsibility boundary:**

- Does: read `state.consecutive_failure_count` + `config.loop.max_consecutive_failures`,
  call pure helper, write back via `stateStore.update()`, return outcome.
- Does not: transition phase, build result, write iteration-log, catch exceptions.

**Why a separate file (not inside `run-orchestrator.ts`):** the orchestrator file
is ~2700 lines. A separate module is unit-testable with a real/lightweight
`StateStore` (mirrors `failure-policy.test.ts` style), separates P6 breaker logic
from generic state-machine primitives, and leaves room for Round 3 retry/escalation
helpers in the same neighborhood.

### Modified: `src/orchestrator/run-orchestrator.ts`

**1. Loop-top early-exit gate** — after cancel check (`:757`), before DEVELOPING (`:771`):

```ts
// Phase 8D P6: run-level circuit breaker. Cancel takes priority.
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
```

- **Threshold uses `>=`** to match the Round 1 pure helper
  (`thresholdReached = nextCount >= maxConsecutiveFailures`).
- **`appendLog` phase uses `breakerState.phase`**, not a hardcoded `'DEVELOPING'`.
  At trip time the phase is typically `REWORKING` (set by the prior soft failure);
  hardcoding `DEVELOPING` would mislead the log.
- **`resumable: false`**: the breaker is this run's failure terminal. Continuing
  requires a deliberate user action (new start, or config change then resume), not
  a CLI hint that "just resume."

**2. Four soft-failure inserts** — at each `continue` branch, before the
`if (iteration >= maxIterations)` check:

```ts
// Phase 8D P6: track soft failure before rework/terminal handling.
await recordSoftFailure(stateStore, config, 'verification_failed');
```

(`failureClass` per the mapping table; comment style kept to one line — no banner.)

**3. PASS reset** — at `:1452` Auditor PASS, after `transition(FINALIZING)` +
`appendLog(PASS)`, before `dispatchFeedbackBlocks`:

```ts
if (decision === 'PASS') {
  await stateStore.transition(PhaseEnum.FINALIZING);
  await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'PASS');

  // Phase 8D P6: passing iteration resets the run-level failure counter.
  await recordSoftFailurePass(stateStore, config);

  await dispatchFeedbackBlocks({...}).catch(() => { /* failure-safe */ });
  return await runFinalization({...});
}
```

- **Not wrapped in try/catch.** `stateStore.update()` failure is an infrastructure
  fault; swallowing it would leave "finalization proceeded but counter not reset"
  — an inconsistent state. Consistent with the four soft-failure inserts (also un-caught).

### Modified: `src/types.ts`

```ts
// ErrorCategory — add:
CONSECUTIVE_FAILURE_LIMIT: 'CONSECUTIVE_FAILURE_LIMIT',

// ERROR_CATEGORY_DEFAULT_RESULT — add:
[ErrorCategory.CONSECUTIVE_FAILURE_LIMIT, Phase.FAILED],
```

---

## Data Contract

No new state fields (Round 1 already added `consecutive_failure_count`). No new
config keys (Round 1 already added `max_consecutive_failures`). The only type-level
change is the `ErrorCategory` / `ERROR_CATEGORY_DEFAULT_RESULT` extension above.

---

## Resume Behavior

- **Single-goal resume:** enters `runIterationLoop` (`run-orchestrator.ts:373`).
  The loop-top gate reads `stateStore.read()`, so `consecutive_failure_count` is
  carried over from the persisted `state.json`. **No migration code, no resume-
  specific branch.**
- **Self-correctness of resume semantics:**
  - User raises `max_consecutive_failures` (3→5) and resumes with count=3:
    `3 >= 5` false → continues. Correct (explicitly granting more chances).
  - User changes nothing and resumes with count=3, max=3: `3 >= 3` true → re-trips
    FAILED immediately. Correct (idempotent; continuing requires a deliberate change).
- **Task-graph resume:** `:346-348` force-transitions BLOCKED→DEVELOPING and calls
  `runTaskGraphLoop`. The counter is **not read or written** on this path. Any
  stale nonzero value sits inert until the next `buildInitialState` zeros it.

---

## Critical Constraint: `max_consecutive_failures < max_iterations`

Because the breaker gate runs at the **loop top** (checked on the *next* iteration
after a failure is recorded), while `iteration >= maxIterations` exhaustion returns
**within the same iteration**, the two race. The same-iteration exhaustion always
wins when both thresholds are equal.

**Therefore: the breaker can only trip before iteration exhaustion if
`max_consecutive_failures < max_iterations`.** With defaults (`max_iterations: 3`,
`max_consecutive_failures: 3`) the breaker is inert — iteration exhaustion preempts
it every time.

This is the natural consequence of the "single loop-top gate" design (D4), **not a
bug.** It is documented here and asserted by test I3. Users wanting the breaker to
fire must set `max_consecutive_failures` below `max_iterations` (e.g. breaker=2,
iterations=5).

---

## FailureClass Enum: Two Values Reserved for Round 3

`FailureClass` has four values. Round 2 wires only two:

- `verification_failed` — points #1/#2/#3
- `auditor_block` — point #4

`developer_blocked` and `infrastructure_error` have **no call sites this round.**
They are kept (the pure `isFailureClass` validator still accepts them) as Round 3
reservation (task-graph + `max_agent_retries` / escalation paths). Not removed, not
wired.

---

## Test Coverage

### Layer 1: Pure functions (Round 1, unchanged)

`tests/unit/failure-policy.test.ts` — increment/threshold/reset/validation.

### Layer 2: Helper — `tests/unit/failure-guard.test.ts` (new)

Uses a real `StateStore` against a temp `state.json`.

| ID | Case | Assertion |
|----|------|-----------|
| H1 | `recordSoftFailure` from count=0 | state.count === 1, outcome.count === 1 |
| H2 | persists across calls | second call reads first call's written value |
| H3 | threshold reached | max=3, 2→3 → outcome.thresholdReached === true |
| H4 | below threshold | max=3, 1→2 → outcome.thresholdReached === false |
| H5 | `recordSoftFailurePass` resets | count=2 → state.count === 0 |
| H6 | no other state fields touched | construct baseline via `StateStore.buildInitialState`; record full state object before call, compare after — only `consecutive_failure_count` (and `updated_at`) differ |
| H7 | all four `FailureClass` values accepted | iterate enum, each increments |

### Layer 3: Orchestrator integration — append to `tests/integration/run-orchestrator.test.ts`

| ID | Config | fake-agent auditor behavior | Assertion |
|----|--------|------------------------------|-----------|
| I1 | `max_consecutive_failures: 2, max_iterations: 5` | `audit-fail` | 3rd iteration loop-top early-exits: `FAILED`, `error.code === 'CONSECUTIVE_FAILURE_LIMIT'`, `state.consecutive_failure_count === 2` |
| I2 | `max_consecutive_failures: 3, max_iterations: 3` | `audit-fail-then-pass` | iteration 1 FAIL (count→1), iteration 2 PASS (count reset→0) → run `PASSED`, no breaker trip. (Here the breaker does not fire because PASS resets the count, not because of the inert-default condition of I3 — both reasons happen to hold, but I2 exercises the reset path, I3 the preemption path.) |
| I3 | `max_consecutive_failures: 3, max_iterations: 3` (or breaker ≥ iterations) | `audit-fail` | run `FAILED` but `error.code !== 'CONSECUTIVE_FAILURE_LIMIT'` — same-iteration exhaustion preempts the loop-top gate |

### Layer 4: Error normalization — `tests/unit/error-normalization.test.ts` (modify)

- `:13` `toHaveLength(21)` → `22`.
- Guard test (`:17-21`) auto-covers the new category once the map entry exists.
- New explicit assertion: `expect(ERROR_CATEGORY_DEFAULT_RESULT.get(ErrorCategory.CONSECUTIVE_FAILURE_LIMIT)).toBe(Phase.FAILED)`.

---

## Engineering Gates

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

All must pass. Round 1 baseline: 1018 passed / 66 files. Round 2 adds
`failure-guard.test.ts` (7 cases) + integration cases I1/I2/I3 + one normalization
modification.

---

## Non-Goals (deferred to Round 3 or beyond)

- Task-graph mode counter wiring (`task-graph-loop.ts:516` and related failure
  paths are not touched).
- `max_agent_retries` / same-provider retry budget plumbing.
- `escalation_target` provider upgrade chain.
- `review-loop status` surfacing of `consecutive_failure_count`.
- `.agent/progress.md` surfacing of the counter.
- `last_failure_class` state field (kept out to avoid widening the Round 1 contract).
- `docs/configuration.md` documentation of the new error code.
- Removing or wiring the reserved `developer_blocked` / `infrastructure_error` classes.

---

## Files

**Modify:**
- `src/types.ts` — `ErrorCategory` + `ERROR_CATEGORY_DEFAULT_RESULT`.
- `src/orchestrator/run-orchestrator.ts` — loop-top gate, 4 inserts, PASS reset.

**Create:**
- `src/orchestrator/failure-guard.ts`
- `tests/unit/failure-guard.test.ts`

**Modify (tests):**
- `tests/integration/run-orchestrator.test.ts` — add I1/I2/I3.
- `tests/unit/error-normalization.test.ts` — 21→22, new assertion.

**Do not touch:**
- `src/scheduler/failure-policy.ts` (Round 1, stable).
- `src/orchestrator/task-graph-loop.ts` (task-graph is out of scope).
- `src/orchestrator/state-store.ts` (Round 1 already added the field).
- `src/artifacts/config.ts` (Round 1 already added the config keys).
- `src/cli/**`, `src/runtime/progress-writer.ts`, `prompts/**`, `.agent/**`.
