---
schema_version: 1
run_id: "20260619154814-dqif9k"
goal_id: "phase-8d-p8-task-run-result-handoff"
title: "Phase 8D P8 Task Run Result Handoff Storage"
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
  - "src/orchestrator/task-graph-loop.ts"
  - "src/scheduler/wave-executor.ts"
  - "src/scheduler/worktree-manager.ts"
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

# Phase 8D P8 Task Run Result Handoff Storage

## Objective

Implement Phase 8D P8 only: add a small, tested task-run result handoff storage module so future workers can write `.agent/task-runs/{task_id}/result.json` safely for scheduler code to consume later. Follow `docs/superpowers/plans/2026-06-19-phase-8d-p8-task-run-result-handoff.md`.

## Success Criteria

1. `src/scheduler/task-run-result.ts` exists and exports `TaskRunResultStatus`, `TaskRunResult`, `MissingTaskRunResult`, `FoundTaskRunResult`, `InvalidTaskRunResult`, `ReadTaskRunResultOutcome`, `TaskRunResultError`, `taskRunResultPath`, `writeTaskRunResult`, and `readTaskRunResult`.
2. `taskRunResultPath(projectRoot, taskId)` validates `taskId` with safe task ID rules and returns `<projectRoot>/.agent/task-runs/<taskId>/result.json`.
3. Empty task IDs, path traversal IDs, slash-separated IDs, backslash-separated IDs, and other IDs failing `/^[A-Za-z0-9._-]+$/` are rejected with `TaskRunResultError` code `invalid-task-id` before filesystem access.
4. `writeTaskRunResult(projectRoot, result)` validates `result.task_id`, writes the result JSON atomically with the existing `atomicWriteJSON` helper, and returns the absolute path written.
5. `readTaskRunResult(projectRoot, runId, taskId)` validates `taskId` and returns `found:true` with a valid `TaskRunResult` for valid stored results.
6. `readTaskRunResult` returns `found:false,error:null` for missing result files.
7. `readTaskRunResult` returns `found:false,error.code === "invalid-result-json"` for malformed JSON, invalid schema versions, invalid statuses, or invalid field types.
8. `readTaskRunResult` returns `found:false,error.code === "result-run-id-mismatch"` when the stored `run_id` does not match the requested run ID.
9. `readTaskRunResult` returns `found:false,error.code === "result-task-id-mismatch"` when the stored `task_id` does not match the requested task ID.
10. `tests/unit/task-run-result.test.ts` covers valid path construction, unsafe task IDs, write/read round trip, missing result, malformed JSON, invalid schema/status, run mismatch, and task mismatch.
11. `src/index.ts` is modified only if needed for package export consistency.
12. The following files are not modified: `src/orchestrator/run-orchestrator.ts`, `src/orchestrator/task-graph-loop.ts`, `src/scheduler/wave-executor.ts`, `src/scheduler/worktree-manager.ts`, `src/cli/start.ts`, and `prompts/**`.
13. No wave execution wiring, worker spawning, worktree creation, branch merging, resume behavior changes, or checked-in `.agent/task-runs` files are introduced.
14. Required gates pass: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, and `git diff --check`.

## Non-Goals

- Do not wire P5 wave execution.
- Do not spawn workers.
- Do not create worktrees.
- Do not merge branches.
- Do not change resume behavior.
- Do not modify orchestrator or CLI behavior.
- Do not modify prompts.
- Do not create checked-in `.agent/task-runs` files.
- Do not introduce a new JSON schema dependency.
- Do not perform unrelated refactors.

## Constraints

- Keep code changes tightly scoped to `src/scheduler/task-run-result.ts`, `tests/unit/task-run-result.test.ts`, and optional `src/index.ts` export consistency.
- Use existing project style: TypeScript ESM imports, `fs-extra`, `path` from `node:path`, Vitest tests, and the existing `atomicWriteJSON` helper.
- Implement validation locally with readable `TaskRunResultError` messages.
- Preserve the documented data contract exactly so later scheduler phases can consume it without compatibility shims.
- Do not perform git commits, tags, pushes, destructive git commands, or broad formatting churn.
