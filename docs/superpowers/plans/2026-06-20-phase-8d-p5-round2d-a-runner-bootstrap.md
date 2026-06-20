# Phase 8D P5 Round 2D-a Plan: Worktree Runner Bootstrap + Pass Path

> This is a smaller execution slice of the broader Round 2D plan. Use it when the full runner task is too large for one Developer agent turn.

## Goal

Implement the minimum safe pass-path for `runTaskInWorktree(...)`:

- create/reuse one task worktree
- bootstrap worker-local `.agent`
- run one task through `runTaskGraphTaskSerial(...)`
- commit non-`.agent` task changes on the task branch
- write the main-project `.agent/task-runs/{task_id}/result.json`
- prove the main worktree stays clean

The failed/blocked path hardening can follow in Round 2D-b.

## Authoritative Parent Specs

- `docs/superpowers/specs/2026-06-20-phase-8d-p5-round2d-worktree-worker-runner-requirements.md`
- `docs/superpowers/specs/2026-06-20-phase-8d-p5-round2d-worktree-worker-runner-design.md`
- `docs/superpowers/plans/2026-06-20-phase-8d-p5-round2d-worktree-worker-runner.md`

## Files

Allowed:

- `src/orchestrator/task-graph-worktree-runner.ts` (new)
- `tests/integration/task-graph-worktree-runner.test.ts` (new)
- `src/orchestrator/task-graph-loop.ts` only if a type/export is required for compilation

Forbidden:

- Do not modify `src/orchestrator/run-orchestrator.ts`; guard wording is already updated.
- Do not modify `tests/unit/parallel-execution.test.ts`; guard wording is already updated.
- Do not wire `runWaveExecutorCore` into `runOrchestrator`.
- Do not unblock `--parallel`.
- Do not modify prompts, provider routing, wave compute/executor, failure policy, worktree manager, task-run-result, config schema, or CLI flags.

## Task 1: Add Passing Integration Test

Create `tests/integration/task-graph-worktree-runner.test.ts`.

Use local helpers copied/adapted from `tests/integration/task-graph.test.ts`:

- temporary git repo
- fake-agent config with Developer behavior `task-success`
- prompt copy
- committed clean baseline

Create a minimal task graph with one task:

- `task-1`
- title: `Implement part A`
- `parallelizable: true`
- `depends_on: []`
- `allowed_changes: ["src/part-a/**"]`
- verification command: `node -e "process.exit(0)"`

Call `runTaskInWorktree(...)` directly.

Assertions:

- result status is `passed`
- result branch starts with `agent/<run_id>/`
- result worktree path is under `.agent/worktrees/<run_id>/task-1`
- main project does not contain `src/part-a/impl.ts`
- worktree contains `src/part-a/impl.ts`
- main `.agent/task-runs/task-1/result.json` exists and validates through `readTaskRunResult(...)`
- stored result has matching `run_id`, `task_id`, `status: "passed"`, non-null `branch`, non-null `final_commit_sha`, non-null `diff_digest`
- `git show --name-only <final_commit_sha>` in the worktree includes `src/part-a/impl.ts`
- main `git status --short` is empty

Run:

```bash
npm test -- --run tests/integration/task-graph-worktree-runner.test.ts
```

Expected first result: red because the runner does not exist.

## Task 2: Implement Pass Path

Create `src/orchestrator/task-graph-worktree-runner.ts`.

Export:

- `RunTaskInWorktreeParams`
- `RunTaskInWorktreeResult`
- `runTaskInWorktree(params)`

Minimum implementation:

1. Create/reuse worktree with `WorktreeManager.createForTask`.
2. Initialize worker `ArtifactStore`.
3. Copy main `GOAL.md` and `task-graph.json` to worker `.agent`.
4. Create worker `StateStore`.
5. Transition worker state legally through `PLANNING` and `DEVELOPING`.
6. Set worker `iteration`, `goal_digest`, and `task_graph_state`.
7. Create worker-local `OrchestratorFileRegistry`.
8. Register worker `.agent/GOAL.md`, `.agent/task-graph.json`, and `.agent/state.json`.
9. Call `runTaskGraphTaskSerial(...)` with worker paths and worker state/artifacts/registry.
10. If task passes, stage and commit only changed paths outside `.agent/**`.
11. Collect a worktree diff digest from `baseCommit`.
12. Write `TaskRunResult` in the main project using `writeTaskRunResult(...)`.
13. Return the structured result.

Private helper rules:

- Use git to discover changed files.
- Stage explicit file paths only.
- Exclude `.agent/**`.
- Do not use `git add -A`.
- Do not push.

## Task 3: Focused Validation

Run:

```bash
npm test -- --run tests/integration/task-graph-worktree-runner.test.ts
npm run typecheck
npm run lint -- --max-warnings 0
```

## Out Of Scope For 2D-a

- Failed/blocked result path test.
- Cleanup behavior.
- Wave executor wiring.
- `--parallel` unblock.
- Final full test suite.

Those are Round 2D-b / 2E work.

## Commit Message

If focused validation passes:

```bash
git commit -m "feat(phase-8d/p5): add worktree runner pass path"
```

