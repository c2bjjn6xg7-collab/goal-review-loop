# Phase 8D P5 Round 2D Design: Worktree Task Worker Runner

## Decision

Implement the worktree worker runner before enabling wave-mode orchestration.

This keeps Phase 8D honest: `--parallel` remains fail-closed until each task can be executed in an isolated worktree with an explicit artifact handoff back to the main scheduler.

## New Module

Create `src/orchestrator/task-graph-worktree-runner.ts`.

Suggested public API:

```ts
export interface RunTaskInWorktreeParams {
  mainProjectRoot: string;
  runId: string;
  config: ReviewLoopConfig;
  currentBranch: string;
  baseCommit: string;
  goalDigest: string;
  taskGraph: TaskGraph;
  task: TaskNode;
  taskIndex: number;
  taskTotal: number;
  maxIterations: number;
  combinedSignal: AbortSignal;
  goalSourcePath: string;
  taskGraphSourcePath: string;
}

export interface RunTaskInWorktreeResult {
  taskId: string;
  status: 'passed' | 'failed' | 'blocked';
  error: string | null;
  branch: string;
  worktreePath: string;
  finalCommitSha: string | null;
  diffDigest: string | null;
  resultPath: string;
}

export async function runTaskInWorktree(
  params: RunTaskInWorktreeParams,
): Promise<RunTaskInWorktreeResult>;
```

The return shape may include additional diagnostic fields if tests need them, but it must remain convertible to `WaveTaskRunnerResult`.

## Execution Flow

1. Create or reuse the worktree:
   - `const manager = new WorktreeManager(mainProjectRoot)`
   - `manager.createForTask({ runId, taskId: task.id, slug: task.title, baseCommit })`
2. Initialize the worker `.agent`:
   - `const workerArtifactStore = new ArtifactStore(worktreePath)`
   - `await workerArtifactStore.init()`
   - copy main `GOAL.md` to `${worktreePath}/.agent/GOAL.md`
   - copy main `task-graph.json` to `${worktreePath}/.agent/task-graph.json`
3. Initialize worker state:
   - `const workerStateStore = new StateStore(workerAgentDir)`
   - create initial state if absent
   - transition legally through `INITIALIZING → PLANNING → DEVELOPING`
   - set `iteration`, `goal_digest`, and `task_graph_state`
4. Create a worker-local `OrchestratorFileRegistry`.
   - Register copied `GOAL.md`, `task-graph.json`, `state.json`, and current worker `.agent` files.
   - Do not pass the main scheduler registry into the worker helper.
5. Call `runTaskGraphTaskSerial(...)` with:
   - `projectRoot: worktreePath`
   - `agentDir: workerAgentDir`
   - worker state/artifact/registry
   - the same `taskGraph`, `task`, config, base commit, and max iterations
6. Convert the helper result to a task-run result.
7. For a passing task, stage and commit only non-`.agent/**` changed files.
8. Restore tracked `.agent` changes in the worktree after result capture so the worktree can be inspected or safely cleaned later.
9. Write the main scheduler result through `writeTaskRunResult(mainProjectRoot, result)`.

## Worker State Bootstrap

The worker state is diagnostic state for one task, not the scheduler state.

Requirements:

- Use `StateStore.create(...)`; do not hand-write `state.json`.
- Do not transition directly from `INITIALIZING` to `DEVELOPING`.
- Set `task_graph_state` with all task statuses initialized, then mark the current task `running`.
- Set `task_attempts[task.id]` as the helper updates attempts.
- Do not mutate the main scheduler `task_graph_state`.

## Task Commit Helper

Add a small internal helper in the same module:

```ts
async function commitWorktreeTaskChanges(params: {
  worktreePath: string;
  taskId: string;
  runId: string;
}): Promise<{ commitSha: string | null; changedFiles: string[] }>;
```

Rules:

- Discover changed files with git, not filesystem recursion.
- Exclude `.agent/**` from staging.
- Stage explicit file paths only.
- If no non-`.agent` changed files exist, return current `HEAD` and an empty changed-file list.
- Commit message should be deterministic: `feat(agent): complete ${taskId} [${runId}]`.
- Do not push.

## Result Mapping

Write a `TaskRunResult` to the main project:

```ts
{
  schema_version: 1,
  run_id: runId,
  task_id: task.id,
  status: 'passed' | 'failed' | 'blocked',
  exit_code: status === 'passed' ? 0 : 1,
  final_commit_sha: commitSha,
  diff_digest: diffDigest,
  branch,
  error,
  finished_at
}
```

`diff_digest` should use the worktree diff from `baseCommit` and should be `null` only if diff collection itself fails before the task can be classified.

## Fail-Closed Semantics

- Worktree creation failure → failed result with readable error.
- Worker state bootstrap failure → failed result with readable error.
- `runTaskGraphTaskSerial` terminal cancellation result → blocked result unless the parent signal is explicitly cancelled, in which case propagate cancellation to the future wave caller.
- Commit failure after a task passes → failed result, because uncommitted task changes cannot be handed off safely.
- Invalid or missing result write should throw; the caller must not silently continue.

## Existing Guard Update

The Round 2B `runOrchestrator` guard currently says wave execution is not wired until Round 2C. Round 2C is complete, so update the message and test wording to say the remaining wiring is Round 2E.

Do not remove the guard in this round.

## Tests

Add `tests/integration/task-graph-worktree-runner.test.ts`.

Required scenarios:

1. Passing fake task:
   - uses fake Developer behavior `task-success`
   - creates a worktree under `.agent/worktrees/{run_id}/{task_id}`
   - writes `src/part-a/impl.ts` in the worktree
   - leaves the main project without `src/part-a/impl.ts`
   - creates a task branch commit containing `src/part-a/impl.ts`
   - writes valid main `.agent/task-runs/task-1/result.json`
2. Failing fake task:
   - uses fake Developer behavior `blocked-handoff` or `scope-violation`
   - writes a failed/blocked result
   - does not commit unverified source changes
3. Guard wording:
   - existing parallel opt-in guard still returns `CONFIG_ERROR`
   - message points to Round 2E, not Round 2C

Run focused tests first, then the full gate.

