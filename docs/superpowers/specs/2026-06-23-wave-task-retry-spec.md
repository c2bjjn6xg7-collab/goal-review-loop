# Wave Mode Per-Task Retry

> Date: 2026-06-23
> Status: Spec — ready for implementation
> Priority: High — currently any single task failure in wave mode blocks the entire run

## Problem

In **serial task-graph mode** (`task-graph-loop.ts`), each task gets up to `maxIterations` (default 3) attempts. If the developer fails, it retries automatically.

In **wave parallel mode** (`task-graph-wave-loop.ts`), each task runs exactly **once** (`attempts: 1`, line 233). If any task's developer fails (exit code 1, timeout, etc.), the entire run is BLOCKED — even if 3 out of 4 tasks passed. All worktree changes from successful tasks are lost unless manually cherry-picked.

This was observed in production: R6 dashboard refresh had 4 tasks across 3 waves. Tasks 1, 3, 4 passed; task-2's developer (claude) exited with code 1. The entire run BLOCKED. Recovery required manual cherry-pick of 3 worktree branches + manual completion of task-2.

## Goal

Add per-task retry to wave mode, mirroring serial mode's retry behavior. When a task's developer fails with `AGENT_ERROR`, retry that task (up to `max_agent_retries` from config) before declaring it failed.

## Non-Goals

- Do not retry on `CANCELLED` status (user intentionally cancelled).
- Do not retry integration/audit/finalization failures (those are pipeline-level, not task-level).
- Do not change serial mode behavior (it already has retry).
- Do not change `max_iterations` semantics (that's for rework loops, not agent crashes).
- Do not change the wave structure (which tasks are parallel/serial).

## Implementation

### 1. task-graph-worktree-runner.ts: add retry loop

**File**: `src/orchestrator/task-graph-worktree-runner.ts`

The function `runTaskInWorktree()` calls `runTaskGraphTaskSerial()` once. Wrap it in a retry loop:

```ts
const maxRetries = config.loop.max_agent_retries ?? 0;
let lastResult: TaskRunResult;

for (let attempt = 0; attempt <= maxRetries; attempt++) {
  if (attempt > 0) {
    // Log retry
    await appendLog(artifactStore, runId, iteration, 'DEVELOPING',
      `task ${task.id} retry ${attempt}`, 'FAIL',
      `Task ${task.id} developer failed, retrying (attempt ${attempt + 1})`);

    // Reset worktree to clean state for retry
    // (discard the failed attempt's changes)
    await resetWorktreeToBase(worktreePath, baseCommit);
  }

  lastResult = await runTaskGraphTaskSerial({
    // ... existing params ...
    attempt: attempt + 1,
  });

  if (lastResult.status === 'passed') break;

  // Only retry on AGENT_ERROR (crash/stall), not on scope violation or other failures
  if (lastResult.status !== 'failed') break;
  if (!lastResult.error?.includes('AGENT_ERROR') && !lastResult.error?.includes('exit')) break;
}

return lastResult;
```

**Key behaviors:**
- Retry only on developer agent failure (AGENT_ERROR / non-zero exit).
- Before each retry, reset the worktree to base commit (discard failed attempt's partial changes).
- On final failure (all retries exhausted), return the last result as-is.
- Log each retry to the iteration log.

### 2. Worktree reset helper

**File**: `src/orchestrator/task-graph-worktree-runner.ts` or `src/runtime/worktree-manager.ts`

Add a helper to reset a worktree to its base state:

```ts
async function resetWorktreeToBase(worktreePath: string, baseCommit: string): Promise<void> {
  // Discard all changes and return to base commit
  execSync('git checkout -- .', { cwd: worktreePath, stdio: 'pipe' });
  execSync('git clean -fd', { cwd: worktreePath, stdio: 'pipe' });
  execSync(`git reset --hard ${baseCommit}`, { cwd: worktreePath, stdio: 'pipe' });
}
```

This ensures each retry starts clean — no partial edits from the failed attempt.

### 3. Emit retry events

On each retry, emit a `task.started` event (so the dashboard shows the retry):

```ts
await eventBus.emit({
  kind: 'task.started',
  phase: 'DEVELOPING',
  level: 'info',
  message: `Wave ${waveIndex + 1}: retrying ${task.id} (attempt ${attempt + 1})`,
  task_id: task.id,
  wave_index: waveIndex,
  provider: developerAgent.provider ?? 'claude',
  payload: { retry: attempt, task_index: taskIndex, batch_index: batchIndex },
});
```

### 4. Config

No new config field needed. Reuse existing `loop.max_agent_retries` (default 3). This is the same field used by serial task-graph mode and the planner retry loop.

### 5. Wave-loop: propagate retry result

**File**: `src/orchestrator/task-graph-wave-loop.ts`

No change needed to the wave loop itself. `runTaskInWorktree()` already returns a `TaskRunResult` — after the retry loop is added inside it, the wave loop sees the final result (passed after retry, or failed after all retries exhausted). The existing wave-level BLOCKED logic remains correct: if a task is still failed after all retries, the wave blocks.

## Edge Cases

1. **Worktree already has commits from a previous attempt**: Reset to base commit before retry. The `resetWorktreeToBase` helper handles this.

2. **Retry creates a different branch name**: Worktree branches are per-task, not per-attempt. Reuse the same worktree path and branch. The reset ensures clean state.

3. **max_agent_retries = 0**: No retry, behaves exactly as today (1 attempt, immediate BLOCKED on failure).

4. **Parallel tasks in the same wave**: Each task retries independently. Task A can be retrying while Task B is on its first attempt. They run in separate worktrees, no interference.

5. **Developer produces partial output then crashes**: The worktree reset discards partial output. The retry starts fresh.

## Testing

### Unit Tests

**File**: `tests/unit/task-graph-worktree-runner-retry.test.ts` (new)

- Retry on AGENT_ERROR: mock `runTaskGraphTaskSerial` to fail once then pass → assert 2 calls, final result passed.
- No retry on scope violation: mock to fail with scope error → assert 1 call, no retry.
- No retry on CANCELLED: mock to return cancelled → assert 1 call.
- max_agent_retries = 0: assert exactly 1 call regardless of failure.
- Worktree reset called between retries: assert `resetWorktreeToBase` invoked before second attempt.
- All retries exhausted: mock to always fail → assert `maxRetries + 1` calls, final result failed.

### Integration Test

**File**: `tests/integration/wave-task-retry.test.ts` (new)

- Run a wave with 2 tasks using fake-agent.
- Task-1 developer uses `developer-fail-three-then-success` behavior (fails 2 times, succeeds on 3rd).
- Task-2 developer uses normal success behavior.
- Assert: run reaches PASSED (task-1 retried and eventually passed, task-2 passed first try).
- Assert: events.jsonl contains multiple `task.started` events for task-1 (initial + retries).

## Files to Touch

| File | Change |
|---|---|
| `src/orchestrator/task-graph-worktree-runner.ts` | Add retry loop + resetWorktreeToBase helper |
| `tests/unit/task-graph-worktree-runner-retry.test.ts` | NEW — unit tests |
| `tests/integration/wave-task-retry.test.ts` | NEW — integration test |

## Validation

```bash
npm test -- --run tests/unit/task-graph-worktree-runner-retry.test.ts
npm test -- --run tests/integration/wave-task-retry.test.ts
npm test -- --run tests/integration/task-graph-parallel-wave.test.ts
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

## Context

- Serial mode retry: `src/orchestrator/task-graph-loop.ts` line 211 (`for attempt` loop).
- Planner retry: `src/orchestrator/run-orchestrator.ts` line 756 (`maxPlannerRetries` loop).
- Developer retry (serial iteration): `src/orchestrator/run-orchestrator.ts` line 1291.
- Wave task execution: `src/orchestrator/task-graph-worktree-runner.ts` `runTaskInWorktree()`.
- Config: `loop.max_agent_retries` (default 3) in `src/artifacts/config.ts`.
