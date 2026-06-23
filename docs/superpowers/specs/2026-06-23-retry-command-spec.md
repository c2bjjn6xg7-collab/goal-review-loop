# Review-Loop Retry: Auto-Recovery from BLOCKED

> Date: 2026-06-23
> Status: Spec — ready for implementation
> Priority: Critical — runs fail frequently and require manual intervention

## Problem

When a review-loop run reaches BLOCKED (task failed, planner failed, integration failed), the user currently has no easy way to retry. They must manually:

1. `review-loop clean` — remove stale state/lock
2. `review-loop start --request "..."` — start a completely fresh run (loses progress)
3. Or manually cherry-pick successful task branches

This happens frequently because:
- opencode/deepseek planner sometimes fails on complex prompts (artifact freshness check)
- claude developer sometimes fails in worktree (exit 1)
- Integration audit sometimes rejects

The user needs a **one-command retry** that preserves successful work and only re-runs the failed parts.

## Goal

Add `review-loop retry` command that:
1. Reads the BLOCKED state
2. Identifies what failed (planner? which task? integration?)
3. Clears the failure state
4. Resumes from the failure point — successful tasks are skipped

This is essentially `resume` but specifically designed for BLOCKED states (not interrupted/crashed states).

## Implementation

### 1. New CLI command: `review-loop retry`

**File**: `src/cli/retry.ts` (new)

```bash
review-loop retry                    # Retry from BLOCKED state
review-loop retry --force            # Skip confirmations
review-loop retry --recover-lock     # Also recover stale lock if needed
```

Logic:
1. Check state.json exists and phase is BLOCKED
2. Read task_graph_state — identify which tasks passed and which failed
3. Show the user what will be retried:
   ```
   Run: 20260623064313-3bir9z (BLOCKED)
   
   Tasks:
     task-1: passed ✓ (will skip)
     task-2: failed ✗ (will retry)
     task-3: failed ✗ (will retry)
     task-4: passed ✓ (will skip)
   
   Proceed with retry? [y/N]:
   ```
4. On confirmation:
   - Clear run.lock (use acquireOrRecover)
   - Reset failed tasks' status to 'pending' in task_graph_state
   - Keep passed tasks' status as 'passed'
   - Call orchestrator with resume_from

### 2. Orchestrator: retry from BLOCKED

**File**: `src/orchestrator/run-orchestrator.ts`

Add a `retry_from` parameter (similar to `resume_from`):

```ts
export async function runOrchestrator(params: {
  // ... existing params ...
  retry_from?: { run_id: string };
}): Promise<OrchestratorResult>
```

When `retry_from` is set:
1. Load existing state (like resume)
2. Reset BLOCKED phase to the phase before block (DEVELOPING/AUDITING/FINALIZING)
3. Clear last_error
4. Reset failed task statuses to 'pending' in task_graph_state
5. Keep passed task statuses
6. Enter the task-graph loop — it will skip passed tasks and re-run pending ones

### 3. Task-graph resume: skip passed tasks

**File**: `src/orchestrator/task-graph-resume.ts`

`resolveTaskGraphResumeDecision` already has logic to skip passed tasks and restart failed ones. Verify it handles the retry case correctly:
- Tasks with status 'passed' → skip
- Tasks with status 'failed'/'blocked' → reset to 'pending', re-run
- Tasks with status 'pending' → run as normal

### 4. Also handle planner failures

If the BLOCKED was caused by planner failure (not task failure), retry should:
1. Delete stale plan.md, GOAL.md, task-graph.json
2. Re-run the planner from scratch
3. This is a "fresh start" for the planning phase but keeps the run_id

## CLI Flow

```bash
$ review-loop retry

Run: 20260623064313-3bir9z (BLOCKED)
Reason: Parallel wave execution completed with non-passing task(s): task-2: failed

Tasks:
  task-1: passed ✓ (skip)
  task-2: failed ✗ (retry)
  task-3: passed ✓ (skip)
  task-4: passed ✓ (skip)

Proceed with retry? [y/N]: y

Retrying from task-2...
[review-loop] Recovering lock...
[review-loop] Resetting failed tasks...
[review-loop] Resuming run...

# Then normal execution continues (planner skipped, tasks re-run)
```

## Fallback: `--fresh` option

If retry doesn't work (e.g., state is corrupted), add `--fresh`:

```bash
review-loop retry --fresh
```

This clears everything and starts a completely new run with the same request (read from GOAL.md). Equivalent to `clean + start` but preserves the original request text.

## Non-Goals

- Do not change the BLOCKED state machine semantics (BLOCKED is still BLOCKED).
- Do not auto-retry infinitely (retry is a manual command, not automatic).
- Do not change task-graph scheduling or wave computation.

## Testing

- Unit test: retry.ts reads BLOCKED state, identifies failed tasks
- Integration test: BLOCKED run → retry → passed tasks skipped, failed tasks re-run → PASSED
- Integration test: planner failure → retry → planner re-runs → succeeds

## Files to Touch

| File | Change |
|---|---|
| `src/cli/retry.ts` | NEW — retry command |
| `src/cli/index.ts` | Register retry command |
| `src/orchestrator/run-orchestrator.ts` | Add retry_from parameter |
| `src/orchestrator/task-graph-resume.ts` | Verify failed task reset logic |
| `tests/integration/retry-blocked.test.ts` | NEW |

## Validation

```bash
npm test -- --run tests/integration/retry-blocked.test.ts
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
```
