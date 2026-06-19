# Phase 8D P6 Round 1 Failure Guard Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the configuration, persisted state, and pure helper foundation for Phase 8D P6 failure policy, without changing orchestrator behavior yet.

**Architecture:** P6 is intentionally split. Round 1 is a low-risk foundation: schema/defaults for the two new loop settings, `state.json` persistence for the consecutive-failure counter, and pure failure-guard functions with unit tests. Later P6 rounds will wire these helpers into `run-orchestrator`, `task-graph-loop`, wave execution, retry/escalation, status/progress surfacing, and resume.

**Tech Stack:** TypeScript, Ajv config/state schemas, existing `StateStore`, Vitest.

---

## Scope

**In scope**

- Add `loop.max_consecutive_failures` and `loop.max_agent_retries` to config schema/defaults/types.
- Add `consecutive_failure_count` to `RunState` and `state.json` schema/initial state.
- Add a small pure failure-guard helper module and unit tests.
- Add focused config/state tests that pin defaults, ranges, and persistence.
- Preserve current serial behavior and all existing default behavior.

**Out of scope**

- Do not modify `src/orchestrator/run-orchestrator.ts`.
- Do not modify `src/orchestrator/task-graph-loop.ts`.
- Do not modify `src/scheduler/wave-executor.ts`.
- Do not modify CLI start/status commands.
- Do not change `progress.json` / `progress.md` output yet.
- Do not wire retry/escalation behavior yet.
- Do not implement early exit yet.
- Do not create worktrees or run task workers in parallel.
- Do not change prompts.

This round must be behavior-neutral. It only makes the future P6 wiring possible and testable.

---

## Design References

- `docs/phase-8d-worktree-parallel-execution.md` §7.2 / §7.3
- `docs/phase-8d-worktree-parallel-execution.md` §35–44
- `docs/phase-8d-implementation-brief.md` P6 section

P6 full design requires:

- `max_agent_retries` bounds same-provider rework before escalation.
- `max_consecutive_failures` bounds the run-level circuit breaker.
- `consecutive_failure_count` persists across resume.
- Count increments only for tracked failure classes.
- Count resets to 0 on a pass.
- Later wiring exits with `CONSECUTIVE_FAILURE_LIMIT` when the threshold is reached.

Round 1 implements only the foundation above; the actual count updates and exits are later wiring.

---

## Files

Modify:

- `src/types.ts`
- `src/artifacts/config.ts`
- `src/orchestrator/state-store.ts`
- `tests/unit/config.test.ts`
- `tests/unit/state-store.test.ts`

Create:

- `src/scheduler/failure-policy.ts`
- `tests/unit/failure-policy.test.ts`

Do not modify:

- `src/orchestrator/run-orchestrator.ts`
- `src/orchestrator/task-graph-loop.ts`
- `src/scheduler/wave-executor.ts`
- `src/cli/start.ts`
- `src/cli/status.ts`
- `src/runtime/progress-writer.ts`
- `prompts/**`
- `.agent/**` as checked-in runtime state

---

## Data Contract

### Config

Extend `ReviewLoopConfig.loop`:

```ts
loop: {
  max_iterations: number;
  archive_history: boolean;
  stop_on_infrastructure_error: boolean;
  /**
   * Phase 8D P6: run-level circuit breaker threshold.
   * Default: 3. Valid range: integer 1..10.
   */
  max_consecutive_failures: number;
  /**
   * Phase 8D P6: same-provider retry budget before escalation.
   * Default: 1. Valid range: integer 1..10.
   */
  max_agent_retries: number;
}
```

`DEFAULT_CONFIG.loop` must include:

```ts
max_consecutive_failures: 3,
max_agent_retries: 1,
```

Config schema rules:

- `max_consecutive_failures`: integer, minimum 1, maximum 10.
- `max_agent_retries`: integer, minimum 1, maximum 10.
- Backward compatibility: if either key is absent after YAML validation/backfill, fill from `DEFAULT_CONFIG.loop`.

Important: current schema allows older configs where only `max_iterations` is required. Keep that compatibility. Do not add these new fields to `loop.required`.

### State

Extend `RunState`:

```ts
/**
 * Phase 8D P6: consecutive tracked failure count for run-level circuit breaker.
 * Starts at 0, persists across resume, and is wired in later P6 rounds.
 */
consecutive_failure_count: number;
```

State schema rules:

- `consecutive_failure_count`: integer, minimum 0.
- Add it to `STATE_SCHEMA.required`.
- `StateStore.create()` initial state must set it to `0`.
- `StateStore.update()` must preserve and validate nonzero values.

Because `state.json` is internal runtime state, adding this required field is acceptable for new runs. Later resume migration can handle old states if needed.

### Failure Guard Helper

Create `src/scheduler/failure-policy.ts` with a pure API:

```ts
export type FailureClass =
  | 'auditor_block'
  | 'developer_blocked'
  | 'verification_failed'
  | 'infrastructure_error';

export interface FailureGuardInput {
  consecutiveFailureCount: number;
  maxConsecutiveFailures: number;
}

export interface FailureGuardFailureInput extends FailureGuardInput {
  failureClass: FailureClass;
}

export interface FailureGuardUpdate {
  consecutiveFailureCount: number;
  thresholdReached: boolean;
  errorCode: 'CONSECUTIVE_FAILURE_LIMIT' | null;
  message: string | null;
}

export function recordFailureGuardPass(input: FailureGuardInput): FailureGuardUpdate;
export function recordFailureGuardFailure(input: FailureGuardFailureInput): FailureGuardUpdate;
```

Behavior:

- `recordFailureGuardPass(...)` returns count `0`, `thresholdReached: false`, `errorCode: null`, `message: null`.
- `recordFailureGuardFailure(...)` increments count by exactly 1.
- Threshold is reached when the incremented count is `>= maxConsecutiveFailures`.
- When threshold is reached:
  - `errorCode` is exactly `CONSECUTIVE_FAILURE_LIMIT`.
  - `message` includes the failure class, incremented count, and threshold.
- When threshold is not reached:
  - `errorCode: null`
  - `message: null`
- Validate inputs defensively:
  - `consecutiveFailureCount` must be an integer `>= 0`.
  - `maxConsecutiveFailures` must be an integer `>= 1`.
  - invalid values throw `FailurePolicyError`.

Do not import orchestrator modules into this helper. It should stay pure and scheduler-level.

---

## Task 1: Add Config Fields

**Files:**

- Modify: `src/types.ts`
- Modify: `src/artifacts/config.ts`
- Modify: `tests/unit/config.test.ts`

- [ ] **Step 1: Extend config types**

Add `max_consecutive_failures` and `max_agent_retries` to `ReviewLoopConfig.loop` in `src/types.ts` with comments matching the data contract.

- [ ] **Step 2: Extend default config**

Update `DEFAULT_CONFIG.loop` in `src/artifacts/config.ts`:

```ts
loop: {
  max_iterations: 3,
  archive_history: true,
  stop_on_infrastructure_error: true,
  max_consecutive_failures: 3,
  max_agent_retries: 1,
},
```

- [ ] **Step 3: Extend config schema without breaking old YAML**

In `CONFIG_SCHEMA.properties.loop.properties`, add:

```ts
max_consecutive_failures: { type: 'integer', minimum: 1, maximum: 10 },
max_agent_retries: { type: 'integer', minimum: 1, maximum: 10 },
```

Do not add either field to `loop.required`.

- [ ] **Step 4: Add backward-compatible default filling**

In `loadConfig`, near existing Phase 4 loop backfills:

```ts
if (config.loop.max_consecutive_failures === undefined) {
  config.loop.max_consecutive_failures = DEFAULT_CONFIG.loop.max_consecutive_failures;
}
if (config.loop.max_agent_retries === undefined) {
  config.loop.max_agent_retries = DEFAULT_CONFIG.loop.max_agent_retries;
}
```

- [ ] **Step 5: Add focused config tests**

Add tests that verify:

- `DEFAULT_CONFIG.loop.max_consecutive_failures === 3`
- `DEFAULT_CONFIG.loop.max_agent_retries === 1`
- loading an old YAML with `loop: { max_iterations: 3 }` backfills both new values.
- explicit valid values are accepted, including boundary values `1` and `10`.
- `0`, `11`, and non-integer values are rejected for each new field.
- unknown extra fields under `loop` remain rejected by existing `additionalProperties: false`.

Keep tests local to existing config test style. Do not rewrite unrelated fixtures.

---

## Task 2: Persist Consecutive Failure Count

**Files:**

- Modify: `src/types.ts`
- Modify: `src/orchestrator/state-store.ts`
- Modify: `tests/unit/state-store.test.ts`

- [ ] **Step 1: Extend RunState**

Add `consecutive_failure_count: number` to `RunState` near `max_iterations`.

- [ ] **Step 2: Extend state schema**

In `STATE_SCHEMA`:

- Add `consecutive_failure_count` to `required`.
- Add property:

```ts
consecutive_failure_count: { type: 'integer', minimum: 0 },
```

- [ ] **Step 3: Initialize the field**

In `StateStore.buildInitialState(...)`, set:

```ts
consecutive_failure_count: 0,
```

- [ ] **Step 4: Add state tests**

Add tests that verify:

- newly created state has `consecutive_failure_count === 0`.
- `StateStore.update()` can persist `consecutive_failure_count: 2`.
- `StateStore.read()` rejects a directly edited state file with `consecutive_failure_count: -1`.
- `StateStore.read()` rejects a non-integer value such as `1.5`.

Do not alter existing phase-transition tests beyond any required fixture updates.

---

## Task 3: Add Pure Failure Policy Helper

**Files:**

- Create: `src/scheduler/failure-policy.ts`
- Create: `tests/unit/failure-policy.test.ts`

- [ ] **Step 1: Add helper implementation**

Implement the data contract exactly. The module must not read files, write files, spawn processes, import orchestrators, or mutate its inputs.

Suggested error class:

```ts
export class FailurePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailurePolicyError';
  }
}
```

- [ ] **Step 2: Add helper tests**

Add tests that verify:

- pass resets any nonzero count to 0.
- one tracked failure increments 0 → 1.
- threshold is false before the threshold.
- threshold is true at exactly the threshold.
- threshold remains true above the threshold.
- all four `FailureClass` values are accepted.
- threshold message includes the failure class, new count, and threshold.
- invalid count and threshold values throw `FailurePolicyError`.
- helper functions do not mutate the input object.

---

## Task 4: Preserve Behavior

**Files:**

- No new files unless tests require small imports.

- [ ] **Step 1: Confirm no orchestration wiring changed**

Verify `git diff` does not touch:

- `src/orchestrator/run-orchestrator.ts`
- `src/orchestrator/task-graph-loop.ts`
- `src/scheduler/wave-executor.ts`
- `src/cli/status.ts`
- `src/runtime/progress-writer.ts`

- [ ] **Step 2: Run targeted tests**

Run:

```bash
npm test -- --run tests/unit/config.test.ts tests/unit/state-store.test.ts tests/unit/failure-policy.test.ts
```

- [ ] **Step 3: Run engineering gates**

Run:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

All must pass.

---

## Acceptance Criteria

- Config defaults include `max_consecutive_failures: 3` and `max_agent_retries: 1`.
- Old YAML without the new loop keys still loads and gets defaults.
- Config schema rejects invalid low/high/non-integer values.
- `RunState` and `state.json` include `consecutive_failure_count`.
- New runs initialize `consecutive_failure_count` to `0`.
- Nonzero `consecutive_failure_count` persists through `StateStore.update()` / `read()`.
- Invalid negative or non-integer state values are rejected.
- `recordFailureGuardPass()` and `recordFailureGuardFailure()` are pure and tested.
- No orchestrator behavior changes in this round.
- Engineering gates pass.

---

## Explicit Non-Goals For This Round

These are required by full P6, but intentionally deferred:

- Replacing hard-coded Developer retry count with `config.loop.max_agent_retries`.
- Escalating from primary provider to `escalation_target`.
- Marking tasks `BLOCKED` after retry/escalation exhaustion.
- Updating `consecutive_failure_count` from real failure paths.
- Early exit with `CONSECUTIVE_FAILURE_LIMIT`.
- Surfacing nonzero failure count in `review-loop status`.
- Surfacing nonzero failure count in `.agent/progress.md`.
- Resume handling for old state files missing `consecutive_failure_count`.

Deferring these keeps Round 1 small, auditable, and behavior-neutral.

---

## Review-Loop Start Request

Use this as the request body for the implementation run:

```text
Implement Phase 8D P6 Round 1 only, using docs/superpowers/plans/2026-06-19-phase-8d-p6-round1-failure-guard-foundation.md as the authoritative plan.

Hard scope:
- Add config fields loop.max_consecutive_failures and loop.max_agent_retries with defaults/schema/backcompat/tests.
- Add RunState/state.json consecutive_failure_count with schema/default/persistence tests.
- Add pure src/scheduler/failure-policy.ts with tests.
- Preserve behavior: do NOT modify run-orchestrator.ts, task-graph-loop.ts, wave-executor.ts, status.ts, progress-writer.ts, prompts, or CLI start wiring.
- Do NOT wire retry/escalation, failure counter updates, early exit, status/progress surfacing, worktrees, or parallel task execution.

Acceptance:
- Targeted tests pass.
- typecheck, lint --max-warnings 0, build, and full test suite pass.
- Final report must explicitly list any files touched outside the allowed set; if none, say none.
```
