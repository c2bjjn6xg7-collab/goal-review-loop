# Stale Lock Auto-Recovery

> Date: 2026-06-23
> Status: Spec — ready for implementation
> Priority: Medium — improves UX when runs are interrupted

## Problem

When a review-loop run is interrupted (Ctrl+C, crash, power off), the `.agent/run.lock` file remains. The next `review-loop start` fails with "Lock acquisition failed" because the lock is still held — even though the process that created it is dead.

Currently the user must manually run `review-loop clean` or `review-loop resume --recover-lock`. This is confusing for new users who don't know about lock files.

## Goal

When `review-loop start` fails to acquire the lock, automatically check if the lock is stale (process is dead or lock is older than `lock_stale_seconds`). If stale, automatically remove it and retry — no user action needed.

## Non-Goals

- Do not auto-recover locks held by live processes (that would break concurrent runs).
- Do not change `resume` behavior (it already has `--recover-lock`).
- Do not remove the `review-loop clean` command (still useful for full cleanup).

## Implementation

### 1. LockManager: add `acquireOrRecover` method

**File**: `src/runtime/lock-manager.ts`

```ts
/**
 * Try to acquire the lock. If acquisition fails, check if the existing
 * lock is stale (process dead or expired). If stale, remove it and retry.
 * Throws if the lock is held by a live process.
 */
async acquireOrRecover(runId: string, staleSeconds: number): Promise<void>
```

Logic:
1. Try `acquire(runId)`.
2. If acquire succeeds → done.
3. If acquire fails:
   a. Read the lock file.
   b. Check if the lock's PID is alive (`process.kill(pid, 0)`).
   c. If PID is dead → remove lock, retry `acquire(runId)`.
   d. If PID is alive but lock age > staleSeconds → remove lock, retry.
   e. If PID is alive and lock is fresh → throw (real conflict).

### 2. Use acquireOrRecover in orchestrator start path

**File**: `src/orchestrator/run-orchestrator.ts`

Replace the current lock acquisition in the fresh-run path (line ~624):

```ts
// Before:
try {
  await lockManager.acquire(runId);
} catch (err) {
  return makeBlockedResult(runId, projectRoot, `Lock acquisition failed: ${...}`, 'STATE_CONFLICT');
}

// After:
try {
  const staleSeconds = config.runtime.lock_stale_seconds ?? 86400;
  await lockManager.acquireOrRecover(runId, staleSeconds);
} catch (err) {
  return makeBlockedResult(runId, projectRoot, `Lock acquisition failed: ${...}`, 'STATE_CONFLICT');
}
```

Also apply to the resume path (line ~246).

### 3. Also auto-clean stale state.json

If a stale lock is recovered, the `state.json` from the interrupted run may also block a fresh `start` (it reports a non-terminal phase). After recovering a stale lock in the `start` path, check if `state.json` exists with a non-terminal phase. If so, archive it (rename to `state.json.interrupted`) so the fresh run can proceed.

This is only for the `start` path (fresh run). The `resume` path should keep the state.json (it needs it to resume).

### 4. Log the recovery

When a stale lock is auto-recovered, emit a log line and a `run.blocked`→clear event so the operator knows what happened:

```
[review-loop] ℹ️  Recovered stale lock (PID 12345 was dead). Previous interrupted run archived.
```

## Testing

### Unit Test

**File**: `tests/unit/lock-manager-recover.test.ts` (new)

- Stale lock (dead PID) → acquireOrRecover succeeds, lock is replaced.
- Live PID, fresh lock → acquireOrRecover throws.
- Live PID, expired lock (> staleSeconds) → acquireOrRecover succeeds.
- No existing lock → acquireOrRecover succeeds (same as acquire).
- acquireOrRecover called twice in a row → second succeeds (first acquired, second is no-op or replaces).

### Integration Test

**File**: `tests/integration/stale-lock-recovery.test.ts` (new)

- Start a run, simulate crash (kill process, leave lock + non-terminal state).
- Run `review-loop start` again → should auto-recover and start fresh.
- Verify no manual `clean` needed.

## Files to Touch

| File | Change |
|---|---|
| `src/runtime/lock-manager.ts` | Add `acquireOrRecover` method |
| `src/orchestrator/run-orchestrator.ts` | Use `acquireOrRecover` in start + resume paths |
| `tests/unit/lock-manager-recover.test.ts` | NEW |
| `tests/integration/stale-lock-recovery.test.ts` | NEW |

## Validation

```bash
npm test -- --run tests/unit/lock-manager-recover.test.ts
npm test -- --run tests/integration/stale-lock-recovery.test.ts
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
git diff --check
```
