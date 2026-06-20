# Phase 8D P5 Round 2D Implementation Plan: Worktree Task Worker Runner

> For agentic workers: implement this plan exactly. This is a narrow bridge round. Do not unblock `--parallel` yet.

## Goal

Implement a reusable worktree-backed single-task runner so the next P5 round can wire `runWaveExecutorCore` into the orchestrator without sharing the main `.agent` directory.

Authoritative specs:

- `docs/superpowers/specs/2026-06-20-phase-8d-p5-round2d-worktree-worker-runner-requirements.md`
- `docs/superpowers/specs/2026-06-20-phase-8d-p5-round2d-worktree-worker-runner-design.md`

## Files

Allowed to modify:

- `src/orchestrator/task-graph-worktree-runner.ts` (new)
- `src/orchestrator/run-orchestrator.ts` (guard message only)
- `tests/integration/task-graph-worktree-runner.test.ts` (new)
- `tests/unit/parallel-execution.test.ts` (guard wording only, if needed)

Allowed only if TypeScript exports require it:

- `src/orchestrator/task-graph-loop.ts` (export `TaskGraphLoopParams` only if needed; do not change serial behavior)

Forbidden:

- Do not wire `runWaveExecutorCore` into `runOrchestrator`.
- Do not remove the fail-closed wave guard.
- Do not modify prompts.
- Do not modify provider/model routing.
- Do not modify `src/scheduler/wave-executor.ts`, `src/scheduler/wave-compute.ts`, `src/scheduler/failure-policy.ts`, `src/scheduler/worktree-manager.ts`, or `src/scheduler/task-run-result.ts` unless a compile error proves a type-only export is required.
- Do not change serial task-graph semantics.

## Task 1: Characterize Guard Wording

- [ ] Update the existing parallel guard integration test in `tests/unit/parallel-execution.test.ts` so it expects the fail-closed message to reference Round 2E rather than Round 2C.
- [ ] Run:

```bash
npm test -- --run tests/unit/parallel-execution.test.ts
```

Expected: red until `run-orchestrator.ts` message is updated.

- [ ] Update only the message in `src/orchestrator/run-orchestrator.ts`.
- [ ] Re-run the focused test.

## Task 2: Add Worktree Runner Integration Test

- [ ] Create `tests/integration/task-graph-worktree-runner.test.ts`.
- [ ] Reuse local helper patterns from `tests/integration/task-graph.test.ts`:
  - temporary git repo
  - fake-agent config
  - prompt copy
  - committed clean baseline
- [ ] Add a `makeTaskGraph()` helper with at least `task-1` allowed to change `src/part-a/**`.
- [ ] Add a passing test that calls `runTaskInWorktree(...)` directly.
- [ ] Assert:
  - result status is `passed`
  - result branch starts with `agent/{run_id}/`
  - result worktree path is under `.agent/worktrees/{run_id}/task-1`
  - main project does not contain `src/part-a/impl.ts`
  - worktree contains `src/part-a/impl.ts`
  - result JSON exists at main `.agent/task-runs/task-1/result.json`
  - result JSON has matching `run_id`, `task_id`, `status`, `branch`, and non-null `final_commit_sha`
  - `git show --name-only <final_commit_sha>` includes `src/part-a/impl.ts`
  - main `git status --short` is empty
- [ ] Add a failing/blocked test using fake Developer `blocked-handoff` or `scope-violation`.
- [ ] Assert:
  - result status is `failed` or `blocked`
  - task-run result JSON exists
  - `final_commit_sha` is null
  - main `git status --short` is empty
- [ ] Run:

```bash
npm test -- --run tests/integration/task-graph-worktree-runner.test.ts
```

Expected: red because the runner module does not exist yet.

## Task 3: Implement `task-graph-worktree-runner.ts`

- [ ] Create `src/orchestrator/task-graph-worktree-runner.ts`.
- [ ] Export:
  - `RunTaskInWorktreeParams`
  - `RunTaskInWorktreeResult`
  - `runTaskInWorktree(params)`
- [ ] Use `WorktreeManager.createForTask(...)` to create/reuse the worktree.
- [ ] Initialize worker `ArtifactStore` and copy:
  - main `.agent/GOAL.md` → worker `.agent/GOAL.md`
  - main `.agent/task-graph.json` → worker `.agent/task-graph.json`
- [ ] Initialize worker `StateStore` using `create(...)`.
- [ ] Transition worker state legally through `PLANNING` then `DEVELOPING`.
- [ ] Set worker `iteration`, `goal_digest`, and `task_graph_state`.
- [ ] Create a worker-local `OrchestratorFileRegistry`.
- [ ] Register copied worker `.agent` files needed by the helper.
- [ ] Call `runTaskGraphTaskSerial(...)` with worker paths and worker state/artifacts/registry.
- [ ] Convert its result to `passed` / `failed` / `blocked`.
- [ ] Collect a worktree diff digest from `baseCommit`.
- [ ] On pass, stage and commit only non-`.agent/**` changed files.
- [ ] Restore tracked worker `.agent` files after result capture.
- [ ] Write `TaskRunResult` to the main project with `writeTaskRunResult(...)`.
- [ ] Return the structured result.

Implementation notes:

- Use git commands through existing helpers where possible.
- If a small local git helper is simpler, keep it private to this module.
- Do not `git add -A` blindly.
- Do not touch the main scheduler `StateStore`.
- Do not catch and swallow task-run result write failures.

## Task 4: Focused Validation

Run:

```bash
npm test -- --run tests/integration/task-graph-worktree-runner.test.ts tests/unit/parallel-execution.test.ts
```

Fix only issues within the allowed files.

## Task 5: Regression Checks

Run:

```bash
npm test -- --run tests/integration/task-graph.test.ts
npm test -- --run tests/unit/wave-executor.test.ts tests/unit/parallel-execution.test.ts
```

Serial task-graph behavior must remain unchanged.

## Task 6: Full Gates

Run:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

## Task 7: Scope Audit

Before final handoff, run:

```bash
git diff -- src/scheduler/wave-executor.ts src/scheduler/wave-compute.ts src/scheduler/failure-policy.ts src/scheduler/worktree-manager.ts src/scheduler/task-run-result.ts prompts review-loop.yaml
```

Expected: empty diff.

Also verify the `--parallel` guard still fails closed:

```bash
npm test -- --run tests/unit/parallel-execution.test.ts
```

## Commit Message

If all gates pass, commit the implementation as:

```bash
git commit -m "feat(phase-8d/p5): add worktree task runner"
```

