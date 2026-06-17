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

> **Phase boundary (decided 2026-06-17):** Integration merge, cherry-pick,
> `diff_digest` recomputation, and Final Aggregate Audit are Phase 8E, **not**
> Phase 8D. Phase 8D ends when every task has reached a terminal status
> (passed/failed/blocked) with its branch + worktree + per-task artifacts
> recorded. See `docs/phase-8e-integration-and-aggregate-audit.md`.

> **Wave model + failure policy added 2026-06-17:** see §7.1 (wave layering)
> and §7.2 (1-C + 2-C escalation). These supersede any free-form ready-set
> scheduling implied by §7.

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

**Worktree location guard:** because `worktree_root` defaults to
`.agent/worktrees/` (inside the repo), the scope guard
(`src/scope/scope-guard.ts`) must treat `.agent/worktrees/**` as a
system-protected path so a worker never edits another task's worktree or its
own `.agent/`. This is a required compatibility change before Phase 8D lands.
Worktrees outside the repo (e.g. `../<repo>-worktrees/`) are also allowed but
require the same path-isolation check at scheduler level.

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

## 7.1 Wave Scheduling Model

Tasks are scheduled in **waves** derived from the task graph topology, not a
free-form ready-set:

1. **Layer by topological depth.** A task's `wave_index` = longest dependency
   chain length from any root. Tasks with no `depends_on` are wave 0; a task
   whose deepest dependency is in wave N runs in wave N+1.
2. **Run a whole wave concurrently**, up to `max_parallel_workers` and
   per-worker-type limits (§4). Within a wave, the `allowed_changes` overlap
   rule (§7) is enforced — tasks that overlap an already-running task in the
   same wave are **demoted to the next wave** rather than blocking the wave.
3. **A wave is complete when all its non-cancelled tasks reach a terminal
   status** (passed / failed / blocked). The next wave does not start until the
   current wave's failures have been resolved per the failure policy (§7.2).
4. **Non-`parallelizable` tasks** form a wave of size 1 and run alone
   (consistent with §7).

Wave index is recorded on the task result so the UI (Phase 9) can render
parallel lanes per wave.

> The `current_task_index` serial pointer from Phase 8B
> (`src/types.ts` `TaskGraphState`) is **not meaningful** under wave
> scheduling. Resume (§11) must be driven by the per-task status map, not by a
> serial index.

### 7.2 Failure Policy (1-C + 2-C)

Within a wave, task failures are isolated and escalated in two stages:

**1-C — intra-wave isolation:**

- A single task failure does **not** abort sibling tasks in the same wave.
- All non-failed tasks in the wave continue to completion.
- The wave reports `passed` / `failed` / `blocked` counts at `wave.complete`
  (Phase 9 event) before proceeding.

**2-C — per-task escalation ladder (applied to each failed task, in order):**

1. **Rework once on the original provider.** Re-run the same task's Developer
   on the same provider that failed. One attempt only.
2. **Escalate once to a premium provider.** If the rework fails, re-run the
   task on the provider's configured `escalation_target` (Phase 7 §6). The
   escalated run is still scoped to the task's `allowed_changes` — escalation
   does **not** widen scope. If `escalation_target` equals the original
   provider (no stronger tier configured), this step is a no-op and the task
   proceeds directly to step 3.
3. **BLOCKED.** If both fail, the task is marked `blocked`. The run does not
   auto-proceed to integration (Phase 8E) with a blocked task unless the user
   explicitly resolves it via `review-loop resume`.

Scope Guard violations are **not** exempted from the ladder: a stronger model
may comply where a weaker one over-stepped, or the violation may itself be a
false positive from over-tight `allowed_changes` (the overlap algorithm in
§7.1 is intentionally conservative). Escalation gives both cases a chance.

> Provider health/auth failures never trigger the 2-C ladder — they fail the
> task as `infra_error` and BLOCKED (mirrors Phase 7 §7: "Provider 认证失败
> ... BLOCKED，不自动换弱模型"). Retrying LLM work against a broken provider
> only wastes calls.

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

**Resume is driven by per-task status, not the serial `current_task_index`**
(Q1.2). On resume the scheduler must, in order:

1. Recover the scheduler lock (`.agent/scheduler.lock`) via stale-lock
   recovery — never blindly overwrite a live lock.
2. For each task in `task-results.json` (or `.agent/task-runs/{task_id}/`):
   - `passed` → skip. Do not re-run, do not recreate worktree.
   - `running` → check the worktree's child `run.lock` / process liveness.
     If the worker process is still alive, **wait for it to finish naturally**
     (poll its `task-results.json` / child `run.lock` release; the restarted
     scheduler is a new process and cannot reattach the original child handle,
     so it must not spawn a duplicate). If the worker is dead, mark the task
     `failed` and apply the 2-C ladder (§7.2).
   - `failed` / `blocked` → apply the 2-C escalation ladder if attempts
     remain, else leave as terminal.
   - `pending` / `queued` → schedule fresh in the appropriate wave.
3. Re-prune stale worktrees (`git worktree prune`) and surface any orphaned
   `agent/{run_id}/*` branches to the user for confirmation before deletion
   (do not auto-delete).

**Orphan reclamation:** the scheduler must register `process` exit/SIGINT/
SIGTERM handlers that signal all active worker process groups (Phase 8D
spawns workers with `detached: true`, so a scheduler crash otherwise leaves
orphan workers running and incurring cost). This covers crash-during-wave,
which the §8 cancellation path (active cancel) does not.

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

### 12.1 Added acceptance (wave + failure + isolation hardening)

26. **Wave layering:** a graph where tasks T1 (root), T2 (root), T3
    (depends_on T1) produces waves `[T1,T2]` then `[T3]`; T3 does not start
    until both T1 and T2 reach terminal status. Test covers this.
27. **1-C isolation:** in a wave of three tasks where the middle task fails,
    the other two still run to completion and the wave reports mixed
    `passed`/`failed` counts before the next wave starts.
27a. **Wave-gate semantics:** the next wave starts only when every task in the
    current wave has reached `passed` or `blocked` (no task left in
    `running`/`rework`/`escalate`). A `blocked` task does **not** gate the
    next wave — it is isolated and flows to Phase 8E's excluded-tasks. A test
    covers: wave with one passed + one blocked → next wave starts; wave with
    one passed + one still-reworking → next wave does not start.
28. **2-C escalation:** a task failing on the original provider is reworked
    once on the same provider, then once on `escalation_target`, then BLOCKED
    — three transitions, no more. A fake-agent test covers the full ladder.
29. **2-C scope guard:** an escalation run does not widen `allowed_changes`;
    a fake agent that attempts an out-of-scope edit during escalation is
    rejected exactly as a non-escalated run would be.
30. **Overlap algorithm precision:** `src/auth/**` (task A) and
    `src/auth/login.ts` (task B) are detected as conflicting and **not** run
    in the same wave; one is demoted to the next wave. A bare-string-equality
    implementation must fail this test.
31. **Resume by status, not index:** after a scheduler crash mid-wave, resume
    skips `passed` tasks, reattaches or fails `running` tasks, and does not
    touch `current_task_index`. A test simulates a crash with one passed, one
    running, one pending task and asserts only the pending one is scheduled.
32. **Orphan reclamation:** killing the scheduler process leaves no orphan
    worker process alive after the configured grace period (test uses a
    fake-agent worker with a known pid).
33. **Scheduler lock:** `.agent/scheduler.lock` is independent of any
    worktree's `run.lock`; acquiring the scheduler lock does not conflict
    with a worker holding its own worktree `run.lock`.
34. **Worktree path guard:** a worker whose `allowed_changes` nominally
    permits `.agent/worktrees/other-task/**` is still denied (scope guard
    treats `.agent/worktrees/**` as system-protected).

## 13. Suggested Review Loop Request

```text
Implement Phase 8D according to docs/phase-8d-worktree-parallel-execution.md. Treat that document as the source of truth. Implement explicit opt-in parallel execution with branch/worktree isolation and conflict reporting. Do not implement integration branch merge, final commit, or final aggregate audit in this phase.
```

