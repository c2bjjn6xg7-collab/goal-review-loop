# Phase 8D P5 Round 2D Requirements: Worktree Task Worker Runner

## Context

Phase 8D parallel execution now has most of its foundation:

- P3 `WorktreeManager` can create/list/cleanup per-task git worktrees.
- P4 conflict detection and P5 wave compute/executor are implemented and tested.
- P5 Round 2B added explicit `--parallel` / `max_parallel_workers` resolution, but still fails closed before real wave execution.
- P5 Round 2C extracted `runTaskGraphTaskSerial(...)`, the reusable single-task Developer + verification loop.
- P8 added `.agent/task-runs/{task_id}/result.json` read/write helpers.
- P6/P7 added retry/guard/recovery hardening around the existing serial task-graph path.

The missing seam is a safe runner for one task inside one worktree. Without it, wiring `runWaveExecutorCore` into the orchestrator would either share the main `.agent` directory across concurrent tasks or run fake-parallel tasks in the main worktree. Both are unacceptable.

## Goal

Add a reusable worktree-backed task runner that executes exactly one task in an isolated git worktree and writes its result back to the main scheduler.

The runner is the bridge between the existing pure wave executor and future real `--parallel` orchestration.

## Required Behavior

1. Create or reuse a per-task worktree using `WorktreeManager.createForTask`.
2. Bootstrap an isolated worker `.agent` directory inside the task worktree.
3. Copy the current scheduler `GOAL.md` and `task-graph.json` into the worker `.agent` for task prompt context.
4. Create a worker-local `StateStore` and `ArtifactStore`; do not reuse the main scheduler state/artifact store.
5. Run the existing `runTaskGraphTaskSerial(...)` helper with `projectRoot` and `agentDir` pointed at the worktree.
6. Keep the main worktree clean while the task is running and after it finishes.
7. If the task passes, create a task branch commit containing only non-`.agent` task changes.
8. Write `.agent/task-runs/{task_id}/result.json` in the main project via `writeTaskRunResult`.
9. Return a `WaveTaskRunnerResult`-compatible result: `{ taskId, status, error }`.
10. Preserve the existing `--parallel` fail-closed guard; this round does not yet wire wave scheduling into `runOrchestrator`.

## Task Branch Commit Rules

- The Developer must still be instructed not to run git commands.
- The orchestrator runner owns the task branch commit after task verification passes.
- Stage only non-`.agent/**` changed files from the worktree.
- Do not commit worker `.agent` runtime files.
- If the task passes but produces no non-`.agent` changes, write a passed task-run result with `final_commit_sha` equal to the current worktree `HEAD`.
- If commit creation fails, write a failed task-run result and surface the error.

## Isolation Rules

- The main scheduler `.agent/state.json` must not be read or written by the worker helper.
- Worker prompts, handoffs, verification output, evidence, debug logs, and transcripts stay under the worktree `.agent`.
- The only cross-worktree handoff is the main-project `.agent/task-runs/{task_id}/result.json`.
- Worker-local tracked `.agent` files may be restored after execution to keep the worktree clean, but task source changes must remain in the task branch commit.

## Out Of Scope

- Do not unblock `--parallel` in `runOrchestrator`.
- Do not call `runWaveExecutorCore` from the orchestrator yet.
- Do not merge/cherry-pick task branches into the main branch.
- Do not run final integration verification or Final Aggregate Audit.
- Do not add provider/model escalation.
- Do not add detached child-process worker orchestration.
- Do not implement full parallel resume/reattach semantics.
- Do not change prompts unless a test proves a prompt-path bug in the worker bootstrap.

## Acceptance Criteria

1. A passing fake task runs in a dedicated worktree, not the main worktree.
2. The task branch contains the task’s non-`.agent` source change.
3. The main worktree remains clean after the runner completes.
4. The main project receives a valid `.agent/task-runs/{task_id}/result.json` with matching `run_id` and `task_id`.
5. Failed tasks write a failed task-run result without creating a task branch commit for unverified changes.
6. The existing serial task-graph tests still pass.
7. The existing `--parallel` fail-closed behavior still blocks real wave mode with `CONFIG_ERROR`, but the message no longer claims Round 2C is still unwired.
8. Full engineering gates pass: typecheck, lint, build, and full tests.

