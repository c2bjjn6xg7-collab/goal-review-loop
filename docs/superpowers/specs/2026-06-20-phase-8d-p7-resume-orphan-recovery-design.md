# Phase 8D P7 Resume + Orphan Recovery Design

## Summary

P7 makes recovery explicit before enabling more concurrent execution. The implementation fixes the CLI resume gate for task-graph BLOCKED runs, introduces a deterministic task-graph resume decision helper, and adds non-destructive worktree orphan diagnostics for `resume --recover-lock`.

This is intentionally a reliability layer. It does not introduce parallel scheduling, automatic cleanup, branch deletion, or provider escalation.

## Approaches Considered

### A. Minimal CLI Fix Only

Change `determineRecoveryAction()` so `BLOCKED + task_graph_state` returns `continue`.

This fixes the immediate CLI bug but leaves resume-index logic scattered and gives no worktree recovery path. It is too small for P7.

### B. Recommended: Recovery Decision Layer

Add small helpers for task-graph resume decisions and worktree classification, then wire only the safe parts into CLI/orchestrator resume.

This gives P7 a stable seam for future wave execution while keeping behavior conservative and testable.

### C. Full Parallel Resume + Auto Cleanup

Resume active worktrees, delete completed worktrees, and restart wave workers.

This belongs after true worktree-backed parallel execution exists. Doing it now would be speculative and risky.

## Design Decisions

### D1. Task-Graph BLOCKED Is Resumable Only With State

`review-loop resume` already has an early exception allowing terminal `BLOCKED` when `state.task_graph_state` exists, but `determineRecoveryAction()` later rejects it. P7 makes the real recovery action match the early exception:

```ts
case PhaseEnum.BLOCKED:
  if (state.final_commit_sha && !state.tag_created && state.tag_name) {
    return { action: 'continue', reason: 'Commit exists but tag failed — can retry tag creation.' };
  }
  if (state.task_graph_state) {
    return { action: 'continue', reason: 'Task graph blocked on a task — can resume from the saved task state.' };
  }
  return { action: 'blocked', reason: 'Run is blocked. Resolve the blocking issue manually.' };
```

Tag-only finalization recovery stays first because it has a more specific terminal recovery path.

### D2. Resume Index Is Status-Driven

Create `src/orchestrator/task-graph-resume.ts`:

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

Algorithm:

1. `const ordered = orderedTasks(taskGraph)`
2. if `ordered.length === 0`, return `all_tasks_complete`
3. if `taskGraphState` is missing, return task `0` with reason `no task_graph_state; starting at first task`
4. scan ordered tasks for first status in `failed | running | blocked`
5. if none, scan for first status `pending`
6. if none, return `all_tasks_complete` with `taskIndex = ordered.length`

This makes interrupted `running` tasks restart, failed tasks retry, blocked tasks resume, and not-yet-started tasks continue. It also avoids blindly trusting `current_task_index` when statuses are more precise.

### D3. Orchestrator Uses the Helper, Not Raw Index

In `src/orchestrator/run-orchestrator.ts`, replace:

```ts
const resumeTaskIndex = tgState.task_graph_state?.current_task_index ?? 0;
```

with:

```ts
const resumeDecision = resolveTaskGraphResumeDecision(goalValidation.taskGraph, tgState.task_graph_state);
```

Pass `resumeDecision.taskIndex` into `runTaskGraphLoop()` for both decision kinds.

For `all_tasks_complete`, `taskIndex = ordered.length`. The existing `for (let i = startIndex; i < ordered.length; i++)` task loop will skip task execution and continue into the existing integration verification/finalization block. This avoids duplicating finalization logic and prevents an accidental restart from task 0.

### D4. Worktree Recovery Is Classification First

Create `src/scheduler/worktree-recovery.ts`:

```ts
export type WorktreeRecoveryCategory =
  | 'keep_for_resume'
  | 'cleanup_candidate'
  | 'unknown_task'
  | 'no_task_graph_state';

export interface WorktreeRecoveryItem {
  category: WorktreeRecoveryCategory;
  taskId: string;
  branch: string;
  worktreePath: string;
  reason: string;
}

export interface WorktreeRecoveryReport {
  items: WorktreeRecoveryItem[];
  counts: Record<WorktreeRecoveryCategory, number>;
  hasManualAction: boolean;
}

export function classifyRunWorktrees(params: {
  worktrees: WorktreeInfo[];
  taskGraph: TaskGraph | null | undefined;
  taskGraphState: TaskGraphState | null | undefined;
}): WorktreeRecoveryReport;

export function formatWorktreeRecoveryReport(report: WorktreeRecoveryReport): string[];
```

Classification rules:

- missing graph or state: every worktree is `no_task_graph_state`
- task id not in graph: `unknown_task`
- status `passed` or `skipped`: `cleanup_candidate`
- status `failed`, `running`, `blocked`, or `pending`: `keep_for_resume`
- unrecognized status: `unknown_task`

The helper is pure. It does not inspect dirty state, call git, or remove files.

### D5. `recover_lock` Gets Safe Worktree Diagnostics

In `src/cli/resume.ts`, after lock handling and before `determineRecoveryAction()`:

1. if `params.recover_lock` and `state.task_graph_state` exists:
   - create `new WorktreeManager(projectRoot)`
   - `await manager.prune()`
   - `const worktrees = await manager.listForRun(state.run_id)`
   - classify with the helper
   - print summary lines if any worktrees exist
2. catch `WorktreeManagerError` as a `ResumeConsistencyError` with a manual-action suggestion

No cleanup happens automatically. This gives users evidence without risking data loss.

### D6. Tests Use Real Decision Functions

`tests/unit/resume-decision.test.ts` currently asserts enum values rather than real recovery behavior. P7 should convert it into real tests by exporting `determineRecoveryAction()` or moving it into a small helper module.

Integration coverage should prefer `executeResume()` for the CLI gate:

1. start a task-graph run with fake Developer behavior that BLOCKS task 1
2. assert state is `BLOCKED` and `task_graph_state.current_task_index === 0`
3. call `executeResume({ project_root: repoDir })`
4. assert final `state.phase === PASSED` and all task statuses are `passed`

This directly proves the previous CLI gate no longer rejects a task-graph BLOCKED run.

## Components

### 1. CLI Resume

Files:

- `src/cli/resume.ts`
- `tests/unit/resume-decision.test.ts`
- `tests/integration/task-graph.test.ts`

Changes:

- make recovery decision testable
- allow `BLOCKED + task_graph_state`
- add `recover_lock` worktree diagnostic output
- add CLI-level integration coverage through `executeResume()`

### 2. Task-Graph Resume Helper

Files:

- `src/orchestrator/task-graph-resume.ts`
- `tests/unit/task-graph-resume.test.ts`
- `src/orchestrator/run-orchestrator.ts`

Changes:

- resolve resume start from statuses
- wire into task-graph resume path
- log resume decision

### 3. Worktree Recovery Helper

Files:

- `src/scheduler/worktree-recovery.ts`
- `tests/unit/worktree-recovery.test.ts`
- `src/cli/resume.ts`

Changes:

- classify run worktrees safely
- format short recovery summaries
- print diagnostics on `--recover-lock`

## Error Handling

- Invalid or cyclic task graphs keep using existing task graph validation / `orderedTasks()` errors.
- Worktree listing/prune failures during `--recover-lock` should stop resume with a `ResumeConsistencyError`; otherwise the user may resume with misleading recovery evidence.
- Unknown worktrees are warnings, not automatic failures, unless listing/prune itself fails.
- Missing `task_graph_state` for task-graph resume defaults to first task only in the helper; the CLI only treats terminal BLOCKED as resumable when state exists.

## Testing Strategy

Targeted:

```bash
npm test -- --run tests/unit/resume-decision.test.ts
npm test -- --run tests/unit/task-graph-resume.test.ts
npm test -- --run tests/unit/worktree-recovery.test.ts
npm test -- --run tests/integration/task-graph.test.ts -t "resume"
```

Full gates:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

## Acceptance

- `executeResume()` resumes a BLOCKED task-graph run to completion.
- Monolithic BLOCKED remains rejected.
- Resume index selection is deterministic and status-driven.
- `--recover-lock` prints worktree recovery diagnostics and prunes stale git metadata without deleting worktrees.
- Full engineering gates pass.
- No parallel execution, escalation, or automatic worktree deletion is introduced.
