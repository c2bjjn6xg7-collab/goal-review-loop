---
schema_version: 1
run_id: "20260619132548-t8fsjx"
goal_id: "phase-8d-p5-round2c-task-runner-extraction"
title: "Phase 8D P5 Round 2C Task Runner Extraction"
allowed_changes:
  - "src/**"
  - "tests/**"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
  - "src/orchestrator/run-orchestrator.ts"
  - "src/cli/start.ts"
  - "prompts/**"
  - ".agent/task-runs/**"
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

# Phase 8D P5 Round 2C Task Runner Extraction

## Objective

Implement Phase 8D P5 Round 2C only: extract the existing serial per-task Developer/verification attempt loop from `runTaskGraphLoop` into an exported helper named `runTaskGraphTaskSerial` in `src/orchestrator/task-graph-loop.ts`, while preserving all current task graph behavior. Follow `docs/superpowers/plans/2026-06-19-phase-8d-p5-round2c-task-runner-extraction.md` as the implementation guide.

## Success Criteria

1. `src/orchestrator/task-graph-loop.ts` exports `RunTaskGraphTaskSerialParams`, `RunTaskGraphTaskSerialResult`, and `runTaskGraphTaskSerial`.
2. `runTaskGraphTaskSerial` contains the serial per-task Developer/verification attempt loop that was previously inline in `runTaskGraphLoop`.
3. `runTaskGraphLoop` calls `runTaskGraphTaskSerial` and no longer contains the `for (let attempt = 1; attempt <= maxIterations; attempt++)` loop.
4. `runTaskGraphLoop` remains responsible for task ordering, `current_task_index`, task status writes, task-result persistence, BLOCKED transition, final integration verification, audit, and finalization.
5. Existing serial behavior is preserved, including Developer retries, prompt cleanup handling, system protected path verification, Developer handoff validation, feedback block dispatch, task-scoped scope guard, per-task verification, cancellation handling, and artifact registration.
6. `tests/unit/task-graph-loop-structure.test.ts` exists and verifies that `runTaskGraphTaskSerial` is exported and owns the per-task attempt loop.
7. `tests/integration/task-graph.test.ts` is modified only to strengthen the existing passing fake-agent task graph assertions.
8. In the passing fake-agent task graph integration test, task result order remains `task-1`, `task-2`, `task-3`, attempts remain `[1, 1, 1]`, and every result has `verification_passed === true`.
9. `src/orchestrator/run-orchestrator.ts` is not modified and does not call `runWaveExecutorCore`.
10. `src/cli/start.ts` is not modified.
11. No worktrees, parallel Developer/Auditor execution, resume behavior, `.agent/task-runs`, prompt changes, or `current_task_index` semantic changes are introduced.
12. Targeted regression tests pass: `npm test -- tests/unit/task-graph-loop-structure.test.ts`, `npm test -- tests/integration/task-graph.test.ts`, and `npm test -- tests/unit/wave-executor.test.ts tests/unit/parallel-execution.test.ts`.
13. Required gates pass: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, and `git diff --check`.

## Non-Goals

- Do not wire `runWaveExecutorCore` into the orchestrator.
- Do not modify `src/orchestrator/run-orchestrator.ts`.
- Do not modify `src/cli/start.ts`.
- Do not create worktrees.
- Do not run Developer or Auditor agents in parallel.
- Do not add resume behavior.
- Do not add or use `.agent/task-runs`.
- Do not change prompts.
- Do not change `current_task_index` semantics.
- Do not perform unrelated refactors outside the extraction needed for this round.

## Constraints

- Keep implementation changes tightly scoped to `src/orchestrator/task-graph-loop.ts`.
- Keep test changes scoped to `tests/unit/task-graph-loop-structure.test.ts` and the existing passing serial assertions in `tests/integration/task-graph.test.ts`.
- Preserve the Round 2B fail-closed wave guard and confirm `run-orchestrator.ts` has no `runWaveExecutorCore` usage.
- Preserve existing TypeScript ESM style, Vitest patterns, and local orchestrator helper APIs.
- Do not perform git commits, tags, pushes, destructive git commands, worktree creation, or broad formatting churn.
