---
schema_version: 1
run_id: "20260619132548-t8fsjx"
author_role: "planner"
---

# Phase 8D P5 Round 2C Task Runner Extraction

## Requirement Understanding

Implement only Phase 8D P5 Round 2C from `docs/superpowers/plans/2026-06-19-phase-8d-p5-round2c-task-runner-extraction.md`. This round is a refactor-only bridge: extract the existing serial per-task Developer/verification attempt loop from `runTaskGraphLoop` into a new exported helper in the same module, without changing task graph behavior or enabling wave execution.

Required implementation outcomes:

- `src/orchestrator/task-graph-loop.ts` exports `RunTaskGraphTaskSerialParams`, `RunTaskGraphTaskSerialResult`, and `runTaskGraphTaskSerial`.
- `runTaskGraphTaskSerial` owns the existing per-task attempt loop.
- `runTaskGraphLoop` calls `runTaskGraphTaskSerial` and remains responsible for task ordering, `current_task_index`, task-result persistence, BLOCKED transition, final integration verification, audit, and finalization.
- `tests/unit/task-graph-loop-structure.test.ts` is added to prove the extraction structure.
- `tests/integration/task-graph.test.ts` is changed only to strengthen serial task result assertions.
- `src/orchestrator/run-orchestrator.ts`, `src/cli/start.ts`, prompts, resume behavior, `.agent/task-runs`, and wave execution wiring remain untouched.

Acceptance requires the existing serial task graph integration tests to pass, the passing fake-agent task result order to remain `task-1`, `task-2`, `task-3` with attempts `[1, 1, 1]`, the Round 2B fail-closed wave guard to remain untouched, and the full engineering gates to pass.

## Current Project Status

At planning time, `git status --short` was clean.

Relevant current state:

- `src/orchestrator/task-graph-loop.ts` currently exports `runTaskGraphLoop`.
- The per-task Developer/verification attempt loop is still inline in `runTaskGraphLoop`.
- The inline attempt loop currently normalizes task verification commands, writes task-scoped Developer prompts, runs the Developer agent, validates protected paths and handoff output, dispatches feedback blocks, collects task-scoped diffs, enforces task scope, runs task verification, handles retries, and returns cancellation results directly.
- `tests/unit/task-graph-loop-structure.test.ts` does not exist yet.
- `tests/integration/task-graph.test.ts` already verifies the passing three-task fake-agent flow but does not yet assert result order, attempts, or `verification_passed` values in the passing test.
- `tests/unit/parallel-execution.test.ts` and `tests/unit/wave-executor.test.ts` exist from earlier P5 rounds; they are useful related regression coverage.
- `src/orchestrator/run-orchestrator.ts` currently imports `runTaskGraphLoop` and must not be changed in this round.

## Technical Approach

Start with tests that characterize the intended extraction and existing serial behavior. Add the structural unit test from the phase plan so it fails until `runTaskGraphTaskSerial` is exported and contains the attempt loop. Strengthen the existing passing fake-agent integration test by asserting `tr.results.map(task_id)` equals `['task-1', 'task-2', 'task-3']`, attempts equal `[1, 1, 1]`, and every result has `verification_passed === true`.

Then modify only `src/orchestrator/task-graph-loop.ts` for the extraction. Add exported parameter and result interfaces above `runTaskGraphLoop`, importing `TaskNode` from `../types.js` if needed. Add `runTaskGraphTaskSerial(params)` above `runTaskGraphLoop` and move the current inline per-task attempt body into it without changing behavior. Replace `i` references inside the moved body with `taskIndex`, derive `taskIndexDisplay` from `taskIndex + 1`, keep `taskTotal` for prompt/progress messages, and preserve all current retry, break, continue, cleanup, validation, scope, verification, progress, log, and cancellation behavior.

For existing early returns inside the moved attempt loop, return `RunTaskGraphTaskSerialResult` with `terminalResult` carrying the same `makeResult(...)` output that `runTaskGraphLoop` currently returns. In `runTaskGraphLoop`, keep the cancel check before each task, state writes, task status transitions, result persistence, BLOCKED handling, integration verification, audit, and finalization. After task start/progress logging, call `runTaskGraphTaskSerial`, return any `terminalResult`, then use the helper's `passed` and `error` fields for the existing task-result and status flow.

Scope controls are strict: do not import or call `runWaveExecutorCore` from the orchestrator, do not alter Round 2B opt-in guard code, do not modify CLI/start behavior, do not add task-run directories or resume semantics, and do not change prompts.

## Work Breakdown

1. Add `tests/unit/task-graph-loop-structure.test.ts` to assert the helper export and that the attempt loop moved out of `runTaskGraphLoop`.
2. Strengthen `tests/integration/task-graph.test.ts` passing fake-agent assertions for result order, attempt counts, and `verification_passed`.
3. Extract `runTaskGraphTaskSerial` in `src/orchestrator/task-graph-loop.ts`, preserving all existing serial per-task behavior and cancellation result handling.
4. Run targeted regression tests: structural test, task graph integration test, and related P5 unit tests.
5. Run full gates and scope checks: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `git diff --check`, and confirm `run-orchestrator.ts` has no `runWaveExecutorCore` usage.

## Risks

- **Behavior drift during extraction**: The moved loop has many side effects. Preserve call order, retry decisions, logs, progress updates, artifact registration, and cancellation result construction exactly.
- **Ownership boundary regression**: `runTaskGraphLoop` must remain the owner of task ordering, `current_task_index`, task-result persistence, BLOCKED transition, integration verification, audit, and finalization.
- **Index confusion**: The moved code currently uses `i` and `ordered.length`. The helper should consistently use `taskIndex`, `taskIndexDisplay`, and `taskTotal` without changing user-visible task numbering.
- **Structural test brittleness**: The new unit test intentionally checks source structure. Keep the exported helper above `runTaskGraphLoop` and preserve the recognizable attempt-loop shape expected by the phase plan.
- **Scope creep into Round 2D**: Do not wire wave execution, create worktrees, run agents in parallel, add resume behavior, or modify prompts in this round.
