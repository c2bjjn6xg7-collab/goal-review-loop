# Phase 8D Requirement: Worktree Isolation And Parallel Task Execution

> Status: Planned
> Scope: Goal Review Loop repository
> Priority: High
> Parent: `docs/phase-8-intelligent-scheduling-and-parallel-workers.md`
> Depends on: Phase 8C sequential task execution
> Review Loop mode: one focused implementation run

## 1. Purpose

Phase 8D introduces true parallel execution, but only after Phase 8C has proven task graph execution sequentially.

The goal:

```text
validated task graph
  -> scheduler selects independent ready tasks
  -> each task gets its own branch + worktree
  -> workers run concurrently within limits
  -> each task produces task-runs artifacts
  -> conflicts are detected and reported
  -> no final integration merge yet
```

This phase focuses on isolation, cancellation, concurrency limits, and conflict visibility. Final merging belongs to Phase 8E.

## 2. In Scope

- Add explicit parallel execution mode using `--parallel` or config.
- Create one Git branch per task.
- Create one Git worktree per running task.
- Run ready independent tasks concurrently up to configured limits.
- Respect global `max_parallel_workers`.
- Respect per-worker-category limits.
- Prevent concurrent tasks with overlapping `allowed_changes`.
- Run task-specific Developer, verification, and Auditor inside each task worktree.
- Write per-task artifacts under the main `.agent/task-runs/{task_id}/` directory.
- Record branch, worktree, base commit, provider, start/end time, and status per task.
- Stop queued and running workers on cancellation.
- Detect conflicts and write `.agent/conflict-report.md`.
- Update status/dashboard with worker pool and per-task execution state.
- Clean up worktrees when configured.

## 3. Out Of Scope

- Do not merge task branches into an integration branch.
- Do not create the final commit.
- Do not run Final Aggregate Audit.
- Do not auto-resolve merge conflicts.
- Do not push task branches to remote.
- Do not run browser-triggered dashboard mutations.
- Do not allow unbounded concurrency.
- Do not use external workspace providers as automatic workers unless they have an explicit artifact handshake implementation.

## 4. CLI And Config

Parallel mode must be explicit:

```bash
review-loop start --parallel --max-parallel-workers 2 --request "..."
```

Config:

```yaml
parallel:
  enabled: true
  max_parallel_workers: 2
  worktree_root: .agent/worktrees
  cleanup_worktrees: true
  per_worker_type:
    cheap_worker: 2
    standard_worker: 1
    premium_worker: 1
```

Defaults must remain safe:

- `parallel.enabled: false`
- `max_parallel_workers: 2`
- `cleanup_worktrees: true`

## 5. Branch And Worktree Strategy

For each task:

```text
branch: agent/{run_id}/{task_id}-{task_slug}
worktree: .agent/worktrees/{run_id}/{task_id}/
```

Integration branch is not used in Phase 8D.

The orchestrator must record:

```json
{
  "task_id": "task-001",
  "base_commit": "abc123",
  "branch": "agent/20260616000000/task-001-example",
  "worktree_path": ".agent/worktrees/20260616000000/task-001",
  "created_at": "2026-06-16T00:00:00.000Z",
  "cleanup_status": "pending"
}
```

## 6. Isolation Rules

Workers must:

- run with `cwd` set to their task worktree
- only modify files allowed by the task
- never modify the main worktree
- never modify another task worktree
- never modify `.agent/task-graph.json`
- write task handoff through orchestrator-approved paths

The orchestrator must:

- create worktrees from the same stable base commit
- verify branch exists before worker starts
- verify worktree path is under configured `worktree_root`
- collect diff evidence from the task worktree
- copy or normalize task artifacts back to main `.agent/task-runs/{task_id}/`
- fail closed if worktree setup or cleanup fails

## 7. Concurrency Rules

Scheduler must only run a task when:

- dependencies are `passed`
- task status is `pending` or `queued`
- global parallel slot is available
- worker-category slot is available
- task is `parallelizable`
- no running task has overlapping `allowed_changes`
- task worker provider is available or has a valid manual/external workflow

If a non-parallelizable task is ready, it may run only when no other task is running.

## 8. Cancellation

Cancellation must:

- stop queued tasks
- signal running worker processes
- wait for configured grace period
- mark running tasks `cancelled`
- mark queued tasks `cancelled`
- preserve task artifacts already written
- clean up worktrees according to config when safe

Cancellation must not leave the main worktree dirty.

## 9. Conflict Detection

Phase 8D must detect, but not merge-resolve:

- overlapping changed files
- overlapping allowed scopes
- task branch missing
- task diff outside `allowed_changes`
- task base commit mismatch
- task verification invalidated by another task's output

Write:

```text
.agent/conflict-report.md
```

The report must include:

- run ID
- task IDs
- branch names
- worktree paths
- files involved
- conflict type
- recommended next action

## 10. Status And Dashboard

`review-loop status --json` should include:

```json
{
  "parallel_execution": {
    "enabled": true,
    "max_parallel_workers": 2,
    "running_count": 2,
    "queued_count": 1,
    "passed_count": 3,
    "blocked_count": 0,
    "worker_pool": [
      {
        "worker": "cheap_worker",
        "provider": "opencode_qwen",
        "running": 2,
        "max_parallel": 2
      }
    ]
  }
}
```

Dashboard must show:

- worker pool
- running tasks
- queued tasks
- per-task branch/worktree
- per-task verification/audit status
- conflict report summary
- cancellation state

Dashboard remains read-only.

## 11. Resume

Resume must recover from:

- scheduler phase
- worktree creation after branch exists
- running worker interrupted before handoff
- verification completed but audit pending
- task passed but cleanup pending
- cancellation with queued tasks

Resume must not duplicate task branches, worktrees, task handoffs, or task audit reports.

## 12. Acceptance Criteria

Phase 8D is complete when:

1. `review-loop start --parallel` enables parallel task execution explicitly.
2. Parallel mode is disabled by default.
3. Each running task uses its own branch and worktree.
4. Workers run with `cwd` set to their task worktree.
5. Global and per-worker parallel limits are enforced.
6. Overlapping `allowed_changes` tasks are not run concurrently.
7. Non-parallelizable tasks wait until no other task is running.
8. Per-task handoff, verification, audit, transcript, and diff artifacts are stored under `.agent/task-runs/{task_id}/`.
9. Task worktree setup errors fail closed.
10. Task worktree cleanup errors fail closed or are reported as BLOCKED with clear next action.
11. Cancellation stops queued and running tasks.
12. Main worktree remains clean after successful parallel task execution.
13. Conflict report is generated for overlapping output or invalid task diff.
14. Status JSON includes parallel execution and worker pool summary.
15. Dashboard reader includes parallel execution and worker pool summary.
16. Resume is idempotent for branch/worktree/task artifact recovery.
17. Existing Phase 8C sequential execution still works.
18. Existing single-worker mode still works.
19. Tests cover at least a two-task parallel fake-agent run.
20. Tests cover overlap rejection.
21. Tests cover cancellation.
22. Tests cover worktree cleanup.
23. Tests cover resume idempotency.
24. No integration merge, final commit, or Final Aggregate Audit is implemented in this phase.
25. Engineering gates pass: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm audit --omit=dev`, `npm pack --dry-run`, and `git diff --check`.

## 13. Suggested Review Loop Request

```text
Implement Phase 8D according to docs/phase-8d-worktree-parallel-execution.md. Treat that document as the source of truth. Implement explicit opt-in parallel execution with branch/worktree isolation and conflict reporting. Do not implement integration branch merge, final commit, or final aggregate audit in this phase.
```

