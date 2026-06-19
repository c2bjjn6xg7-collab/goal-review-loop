---
schema_version: 1
run_id: "20260619154814-dqif9k"
author_role: "planner"
---

# Phase 8D P8 Task Run Result Handoff Storage

## Requirement Understanding

Implement Phase 8D P8 only: a storage-only task-run result handoff API for future scheduler/worktree workers. The implementation must follow `docs/superpowers/plans/2026-06-19-phase-8d-p8-task-run-result-handoff.md`.

Required outcomes:

- Create `src/scheduler/task-run-result.ts`.
- Create `tests/unit/task-run-result.test.ts`.
- Modify `src/index.ts` only if needed for package export consistency.
- Provide `taskRunResultPath(projectRoot, taskId)` that validates task IDs and returns `<projectRoot>/.agent/task-runs/<taskId>/result.json`.
- Provide `writeTaskRunResult(projectRoot, result)` that validates `result.task_id`, writes valid JSON atomically with the existing atomic JSON helper, and returns the absolute written path.
- Provide `readTaskRunResult(projectRoot, runId, taskId)` that distinguishes valid, missing, invalid/corrupt, run-mismatched, and task-mismatched result files.
- Cover valid, missing, malformed, invalid schema/status, run mismatch, task mismatch, and unsafe task ID cases with unit tests.

This round must not wire wave execution, spawn workers, create worktrees, merge branches, change resume behavior, alter prompts, or create checked-in `.agent/task-runs` files.

## Current Project Status

At planning time, `git status --short` was clean.

Relevant current state:

- `docs/superpowers/plans/2026-06-19-phase-8d-p8-task-run-result-handoff.md` defines the exact data contract and test expectations for this round.
- `src/scheduler/task-run-result.ts` does not exist yet.
- `tests/unit/task-run-result.test.ts` does not exist yet.
- `src/index.ts` is the package public API surface and currently exports many core modules. The Developer should add the task-run result export there only if this is needed to keep public package export behavior consistent.
- Existing scheduler/orchestrator files are out of scope for this storage-only round.

## Technical Approach

Start with the unit tests in `tests/unit/task-run-result.test.ts`. Use temporary project roots under `tmpdir()` and import the new API from `../../src/scheduler/task-run-result.js`. Add helpers for building a valid `TaskRunResult` and writing direct corrupt files. The tests should cover safe path construction, unsafe task ID rejection, write/read round trip, missing result, malformed JSON, invalid schema/status, run ID mismatch, and task ID mismatch.

Implement `src/scheduler/task-run-result.ts` as a small local module. Define and export the documented types, `TaskRunResultError`, `taskRunResultPath`, `writeTaskRunResult`, and `readTaskRunResult`. Validate task IDs with `/^[A-Za-z0-9._-]+$/` before path construction or filesystem access. Build paths with `path.join(projectRoot, '.agent', 'task-runs', taskId, 'result.json')`.

Use `atomicWriteJSON` from `src/runtime/atomic-file.ts` for writes. For reads, use `fs.pathExists` or equivalent existence checking, read/parse JSON when present, and return `found:false,error:null` only for missing files. Parse failures, schema failures, and unsupported status values should return `found:false` with `TaskRunResultError` code `invalid-result-json`. Stored run/task mismatches should return `result-run-id-mismatch` and `result-task-id-mismatch` respectively.

After the module and tests pass, inspect `src/index.ts`. If its existing public API pattern requires exporting the new scheduler module, add the documented export block for functions, error class, and types. Otherwise leave `src/index.ts` unchanged and note that in the handoff.

## Work Breakdown

1. Add unit tests for the task-run result contract in `tests/unit/task-run-result.test.ts`.
2. Implement `src/scheduler/task-run-result.ts` with the exported types, safe path builder, atomic writer, reader, error class, and local validator.
3. Update `src/index.ts` only if required by the existing public API export style.
4. Run focused unit coverage with `npm test -- tests/unit/task-run-result.test.ts`.
5. Run full engineering gates: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, and `git diff --check`.

## Risks

- **Scope creep into orchestration**: This phase is storage-only. Do not touch orchestrator, wave executor, worktree manager, CLI start, prompts, resume behavior, branch merging, or checked-in `.agent/task-runs` files.
- **Path traversal or unsafe filesystem access**: Task ID validation must happen before path construction and before reads/writes.
- **Ambiguous corrupt vs missing outcomes**: Missing files must return `found:false,error:null`; malformed JSON and schema failures must return `found:false,error` so future scheduler code can handle them differently.
- **Contract drift**: The exact exported type and function names should match the phase plan so later P8/P5 work can import this module without adapter code.
- **Public API consistency**: `src/index.ts` appears to be the public API aggregator. Exporting the module may be appropriate, but only this file may be modified for that purpose.
