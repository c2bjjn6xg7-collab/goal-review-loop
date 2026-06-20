# Phase 8D P7 Resume + Orphan Recovery Requirements

## Problem

Phase 8D now has the pieces needed for reliable task execution — task graph state, task-run result handoff, worktree management, retry budgets, and plugin-run hardening. The remaining reliability gap is recovery after interruption:

- `runOrchestrator({ resume_from })` can resume a task-graph run that BLOCKED on a failed task, and `tests/integration/task-graph.test.ts` already proves the direct orchestrator path works.
- `review-loop resume` still rejects that same task-graph BLOCKED state because `determineRecoveryAction()` treats generic `BLOCKED` as non-resumable after the earlier terminal-state exception allows it through.
- `WorktreeManager` can create/list/remove worktrees, but there is no recovery classifier for worktrees left under `.agent/worktrees/<run_id>/` after an interrupted future parallel run.
- Resume currently uses `task_graph_state.current_task_index` directly, which is enough for the serial path but brittle for interrupted/running/blocked task statuses and future wave execution.

P7 should make resume decisions explicit, testable, and safe without enabling true parallel execution yet.

## Goals

1. Make `review-loop resume` accept and resume BLOCKED task-graph runs that have `task_graph_state`.
2. Centralize task-graph resume-index resolution so serial resume and future wave resume use the same deterministic rule.
3. Add a non-destructive worktree recovery classifier for `.agent/worktrees/<run_id>/` leftovers.
4. Integrate safe recovery diagnostics into `resume --recover-lock` without deleting unknown or dirty worktrees.
5. Keep the implementation narrow: reliability/recovery only, no scheduling redesign.

## Definitions

### Task-Graph Resumable BLOCKED

A terminal `BLOCKED` run is task-graph resumable when all of these are true:

- `state.phase === "BLOCKED"`
- `state.task_graph_state` is present
- GOAL/plan/branch/base commit consistency checks pass
- the run is not blocked only because final commit/tag recovery should handle it separately

This is distinct from monolithic `BLOCKED`, which remains non-resumable unless it is the existing tag-only finalization recovery case.

### Resume Index

The resume index is the 0-based topological task index where the task graph loop should restart. P7 uses this deterministic priority:

1. earliest task with status `failed`, `running`, or `blocked`
2. otherwise earliest task with status `pending`
3. otherwise no runnable task remains

`current_task_index` is still persisted for compatibility, but it is not the only source of truth.

### Orphan Worktree

A run worktree is a git worktree returned by `WorktreeManager.listForRun(runId)` whose task id does not map cleanly to the task graph state or whose task no longer needs an active worktree. P7 classifies these worktrees but does not force-delete them.

## Requirements

### R1. CLI Resume Decision

- Export or otherwise unit-test the real recovery-decision function used by `src/cli/resume.ts`.
- `determineRecoveryAction()` must return `continue` for `BLOCKED` states with `task_graph_state`.
- The existing tag-only BLOCKED finalization recovery must continue to take precedence.
- Monolithic `BLOCKED` without task graph state remains rejected.
- The console recovery reason should name the task graph resume path, not the generic blocked reason.

### R2. Task-Graph Resume Index Helper

- Add a focused helper module: `src/orchestrator/task-graph-resume.ts`.
- Export:

```ts
export interface TaskGraphResumeDecision {
  kind: 'resume_task' | 'all_tasks_complete';
  taskIndex: number;
  taskId: string | null;
  reason: string;
}

export function resolveTaskGraphResumeDecision(
  taskGraph: TaskGraph,
  taskGraphState: TaskGraphState | null | undefined,
): TaskGraphResumeDecision;
```

- Use `orderedTasks(taskGraph)` from `src/scheduler/task-graph.ts`; do not duplicate topological sorting.
- Treat missing `task_graph_state` as a fresh graph: resume task index `0`.
- Prefer `failed`/`running`/`blocked` tasks over `pending` tasks.
- If all tasks are `passed` or `skipped`, return `all_tasks_complete` with `taskIndex = orderedTasks(taskGraph).length`; this lets the existing task loop skip task execution and continue into integration verification/finalization.
- The helper must not mutate state.

### R3. Orchestrator Resume Integration

- Replace the direct `tgState.task_graph_state?.current_task_index ?? 0` read in `run-orchestrator.ts` with `resolveTaskGraphResumeDecision()`.
- When `state.phase === BLOCKED` and a task graph is resumable, keep the existing `forceTransitionForResume(DEVELOPING)` behavior.
- If the helper returns `all_tasks_complete`, pass `taskIndex = orderedTasks(taskGraph).length` into `runTaskGraphLoop()` so the existing task loop skips task execution and continues into integration verification/finalization.
- Add an iteration-log entry that includes the resume decision reason.

### R4. Worktree Recovery Classifier

- Add a pure helper module: `src/scheduler/worktree-recovery.ts`.
- It must classify `WorktreeInfo[]` from `WorktreeManager.listForRun(runId)` against a `TaskGraph` and `TaskGraphState`.
- Required categories:
  - `keep_for_resume`: task status is `failed`, `running`, `blocked`, or `pending`
  - `cleanup_candidate`: task status is `passed` or `skipped`
  - `unknown_task`: worktree task id is not present in the task graph
  - `no_task_graph_state`: state is missing, so no destructive classification is safe
- The classifier must be pure and must not call git or delete files.
- A formatter must produce a short human-readable summary suitable for CLI output.

### R5. `resume --recover-lock` Diagnostics

- When `executeResume({ recover_lock: true })` handles a task-graph state, it should:
  - keep the existing stale/active lock override behavior
  - call `WorktreeManager.prune()` to remove stale git worktree metadata
  - list and classify run worktrees
  - print the recovery summary if worktrees are present
- It must not call `cleanupTask()` automatically in P7.
- Unknown worktrees must be surfaced as manual-review warnings.

### R6. Tests

Add or update tests proving:

1. Real resume decision logic allows `BLOCKED + task_graph_state`.
2. Real resume decision logic still rejects monolithic `BLOCKED`.
3. Task-graph resume decision picks earliest `failed`, `running`, or `blocked` task.
4. Task-graph resume decision falls back to earliest `pending`.
5. Task-graph resume decision returns `all_tasks_complete` for all passed/skipped.
6. `review-loop resume` / `executeResume()` can resume a BLOCKED task-graph run and reach `PASSED`.
7. Worktree recovery classifier categorizes keep/cleanup/unknown/no-state cases.
8. `recover_lock` worktree diagnostics do not delete worktrees.

### R7. Non-goals

- Do not enable parallel wave execution.
- Do not change task execution semantics or retry budgets.
- Do not implement provider/model escalation.
- Do not delete dirty, unknown, or completed worktrees automatically.
- Do not force-delete task branches.
- Do not migrate the `TaskGraphState` schema.
- Do not change P6 failure guard behavior.
