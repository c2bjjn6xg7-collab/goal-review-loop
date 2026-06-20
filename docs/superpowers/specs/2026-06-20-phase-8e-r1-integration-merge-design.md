# Phase 8E R1 Integration Merge Design

> Requirements: `docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-requirements.md`
> Parent: `docs/phase-8e-integration-and-aggregate-audit.md`

## Decision Summary

R1 implements the integration-branch assembly layer only. It consumes Phase 8D task-run result handoffs, selects safe passed commits in task-graph topological order, cherry-picks them onto `integration/{run_id}`, and records integration evidence. It deliberately does not run Final Aggregate Audit or create the project-level commit/tag yet.

This keeps the riskiest Phase 8E invariant intact: Final Aggregate Audit must later audit a freshly collected integrated diff, not per-task digests.

## New Modules

### `src/orchestrator/integration-plan.ts`

Pure-ish planning helper; it reads task-run result files but does not mutate git.

Suggested exports:

```ts
export interface IntegrationTaskEntry {
  task_id: string;
  branch: string;
  commit_sha: string;
  status: 'passed';
}

export interface ExcludedIntegrationTask {
  task_id: string;
  reason: string;
  status: 'missing' | 'invalid' | 'failed' | 'blocked' | 'passed_without_commit' | 'dependency_excluded';
}

export interface IntegrationPlan {
  schema_version: 1;
  run_id: string;
  base_commit: string;
  integration_branch: string;
  tasks: IntegrationTaskEntry[];
  excluded_tasks: ExcludedIntegrationTask[];
  partial: boolean;
  created_at: string;
}

export async function buildIntegrationPlan(params: {
  projectRoot: string;
  runId: string;
  baseCommit: string;
  taskGraph: TaskGraph;
}): Promise<IntegrationPlan>;
```

Rules:

- Use `orderedTasks(taskGraph)` for ordering.
- Use `readTaskRunResult(projectRoot, runId, task.id)`.
- Only include `status === 'passed'` with non-null `final_commit_sha` and non-null `branch`.
- Exclude descendants of excluded dependencies.
- Never read `result.diff_digest` except, at most, to assert it is ignored in a unit test. Do not copy it into `IntegrationPlan`.

### `src/orchestrator/integration-runner.ts`

Git-mutating runner that applies a plan.

Suggested exports:

```ts
export interface IntegrationRunResult {
  status: 'passed' | 'blocked';
  integration_branch: string;
  applied_tasks: string[];
  skipped_tasks: string[];
  artifact_paths: string[];
  error_message: string | null;
}

export async function runIntegrationMerge(params: {
  projectRoot: string;
  runId: string;
  baseCommit: string;
  plan: IntegrationPlan;
}): Promise<IntegrationRunResult>;
```

Git operations should use `runGit` or a small wrapper around it, matching existing git modules. R1 does not need a generalized git abstraction if tests can create real temporary repositories.

## Artifact Layout

```text
.agent/integration/
  integration-plan.json
  cherry-pick-log.jsonl
  conflict-report.md
  excluded-tasks.md
```

`integration-plan.json` is written before git mutation. `cherry-pick-log.jsonl` is append-only within a run attempt but should remain deterministic in tests; a rerun may recreate it from scratch if the runner treats already-applied commits as `already_applied`.

## Branch Rules

- Branch name: `integration/{run_id}`.
- Validate with `git check-ref-format --branch`.
- Create with `git switch -c integration/{run_id} {base_commit}` if absent.
- If present, verify `git merge-base --is-ancestor {base_commit} integration/{run_id}` before reuse.
- Switch back behavior: R1 may leave the repository on the integration branch because the integration branch is the current work product. The result must state the branch clearly.

## Cherry-Pick Algorithm

For each plan task:

1. Check if the task commit is already contained in the integration branch using `git branch --contains {commit_sha}` or equivalent.
2. If contained, log `already_applied` and continue.
3. Run `git cherry-pick {commit_sha}`.
4. On success, log `applied` with the new HEAD sha.
5. On failure, collect `git diff --name-only --diff-filter=U`, write conflict report, run `git cherry-pick --abort`, and return `blocked`.

No automatic resolution command is allowed.

## Orchestrator Integration

In `src/orchestrator/task-graph-wave-loop.ts`, replace the current all-pass placeholder result with:

1. build integration plan;
2. if exclusions exist and R1 chooses fail-closed, transition BLOCKED and point to `excluded-tasks.md`;
3. run integration merge;
4. if blocked, transition BLOCKED and return `makeBlockedResult`;
5. if passed, transition through `VERIFYING -> AUDITING -> FINALIZING -> PASSED` only if preserving current result shape is necessary, but message/skip_reason must say R1 assembled the integration branch and skipped Final Aggregate Audit/final commit.

The current `PASSED` placeholder is acceptable only before R1. After R1, a wave all-pass result should prove the integration branch contains task files.

## Testing Strategy

Use real temporary git repositories for integration-runner tests. Avoid mocking git conflict behavior; a tiny repo with two branches editing the same line is clearer and harder to fake incorrectly.

Recommended tests:

- `tests/unit/integration-plan.test.ts` for selection/exclusion/transitive dependency and diff_digest non-use.
- `tests/integration/integration-runner.test.ts` for clean cherry-pick, idempotent rerun, conflict report and abort.
- Update `tests/integration/task-graph-parallel-wave.test.ts` so the all-pass wave test expects task files on `integration/{run_id}` rather than absent from the main worktree.

## Follow-Up Slices

R2 should add integrated diff collection, GOAL-level scope guard, GOAL-level verification, Final Aggregate Audit prompt context, and final commit/tag. R1 must leave clear result messaging so users do not confuse “integration branch assembled” with “final audited project commit complete.”
