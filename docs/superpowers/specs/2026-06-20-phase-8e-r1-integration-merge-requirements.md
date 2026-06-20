# Phase 8E R1 Integration Merge Requirements

> Source of truth: `docs/phase-8e-integration-and-aggregate-audit.md`
> Scope: first implementation slice for Phase 8E
> Task sizing policy: `docs/superpowers/agent-task-planning-guidelines.md`

## Problem

Phase 8D wave mode now records passed task branches and task-run artifacts, but it deliberately stops before integration:

- task commits remain isolated on per-task branches;
- the main branch/worktree does not contain task changes;
- integration verification is not run against the combined tree;
- Final Aggregate Audit is not run on an integrated diff;
- no project-level final commit/tag is created.

Phase 8E owns this missing integration step. The full Phase 8E document is broad, so R1 must establish the safe merge foundation without trying to complete all final-audit/finalization behavior in one risky change.

## Goals

1. Add a deterministic integration planner that reads Phase 8D task-run results and selects passed task commits in DAG topological order.
2. Add a git integration runner that creates or reuses `integration/{run_id}` from `base_commit` and cherry-picks selected task commits sequentially.
3. On cherry-pick conflict, abort the cherry-pick, write `.agent/integration/conflict-report.md`, and return BLOCKED without auto-resolving.
4. Write structured integration evidence under `.agent/integration/`.
5. Wire wave-mode success to run the R1 integration step instead of returning the current “Phase 8E owns merge” placeholder.
6. Keep Final Aggregate Audit and project-level final commit/tag out of R1.

## Core Invariants

### I1. Do Not Reuse Per-Task Diff Digests

R1 may read per-task `result.json` for task id, status, branch, and `final_commit_sha`. It must not use `diff_digest` as evidence for the integrated result. The integrated diff digest must be recomputed later from the integration branch.

### I2. No Auto-Resolution

Any cherry-pick conflict must become BLOCKED. The orchestrator must run `git cherry-pick --abort` and write a conflict report. It must not run `git checkout --ours`, `git checkout --theirs`, `git merge-file`, or any equivalent automatic resolution.

### I3. Deterministic Order

Integration order is DAG topological order from `orderedTasks(taskGraph)`, with the existing deterministic tie-breaking. It is not wave order.

### I4. Atomic Task Sizing

This work crosses task-run result reading, git branch/cherry-pick operations, integration artifacts, orchestrator wave wiring, and integration tests. Planner must keep it as one atomic module or at most split only where each slice independently typechecks and passes targeted tests. Do not create narrow file-level tasks that force scope expansion.

## Functional Requirements

### R1. Integration Task Selection

Add a helper that accepts `TaskGraph`, `run_id`, and `project_root`, reads `.agent/task-runs/{task_id}/result.json`, and returns an ordered integration plan.

The plan must include:

- `run_id`
- `base_commit`
- ordered task entries with `task_id`, `branch`, `commit_sha`, and `status: "passed"`
- excluded task entries with a reason
- whether the plan is complete or partial

For R1:

- include only tasks whose task-run result is `status: "passed"` and has non-null `final_commit_sha`;
- exclude missing, malformed, failed, blocked, or passed-without-commit results;
- if a passed task depends on an excluded task, exclude it transitively;
- R1 is fail-closed: any exclusion BLOCKEDs integration, but the plan must record exclusions clearly for the user and for later partial-integration work.

### R2. Integration Branch Runner

Add a runner that:

1. validates `integration/{run_id}` using `git check-ref-format --branch`;
2. creates the branch from `base_commit` if it does not exist;
3. switches to the integration branch;
4. cherry-picks each selected task commit in plan order;
5. records each cherry-pick outcome in `.agent/integration/cherry-pick-log.jsonl`;
6. writes `.agent/integration/integration-plan.json` before cherry-picking.

The runner must be idempotent enough for R1 tests:

- if a task commit is already contained in the integration branch, skip it and log `already_applied`;
- if the integration branch already exists, reuse it only if it points to a descendant of `base_commit`; otherwise BLOCKED with `STATE_CONFLICT`.

### R3. Conflict Handling

On cherry-pick conflict:

- collect conflicted paths from `git diff --name-only --diff-filter=U` before aborting;
- write `.agent/integration/conflict-report.md` with run id, task id, branch, commit sha, conflicted paths, and recommended next action;
- run `git cherry-pick --abort`;
- transition run to `BLOCKED`;
- return an `OrchestratorResult` with error code `VERIFICATION_FAILED` or a more specific existing category if available;
- do not create a final commit or tag.

### R4. Wave Orchestrator Wiring

After all wave tasks pass in `runTaskGraphWaveLoop`, call the R1 integration path instead of returning a placeholder success that tells the user to proceed to Phase 8E manually.

R1 may end in either:

- `PASSED` with `commit_skipped: true` and `skip_reason` explaining that R1 assembled the integration branch but Final Aggregate Audit/final commit are a later 8E slice; or
- `BLOCKED` if exclusions/conflicts/preconditions prevent a safe integration branch.

The result must surface the integration branch and artifact paths.

### R5. Evidence Files

Write under `.agent/integration/`:

- `integration-plan.json`
- `cherry-pick-log.jsonl`
- `conflict-report.md` only on conflict
- optionally `excluded-tasks.md` if any task is excluded

R1 should register these artifacts with the orchestrator file registry if the surrounding call path exposes it; if not, document this as a R2 follow-up in code comments and tests must still assert the files exist and are stable.

### R6. Tests

Add targeted tests covering:

1. all-passed task-run results produce a DAG-ordered integration plan;
2. missing/failed/blocked task results are excluded and surfaced;
3. transitive dependency exclusion works;
4. clean cherry-pick sequence creates/reuses `integration/{run_id}` and applies task files to that branch;
5. already-applied commit is skipped on rerun;
6. cherry-pick conflict writes `conflict-report.md`, aborts cherry-pick, and returns BLOCKED;
7. wave-mode all-pass path now produces an integration branch containing task files instead of leaving the main worktree unchanged;
8. no code path reads per-task `diff_digest` into integrated audit/finalization input.

### R7. Engineering Gates

Run:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

## Non-Goals

- Do not implement automatic conflict resolution.
- Do not implement Final Aggregate Audit in R1.
- Do not create the project-level final commit/tag in R1.
- Do not delete task branches or worktrees.
- Do not change Developer retry/failure guard behavior.
- Do not implement provider/model escalation.
- Do not push to remote.
