# Wave Mode Real-Time Worktree Event Forwarding

> Date: 2026-06-23
> Status: Spec — ready for review-loop implementation
> Priority: High — dashboard is blind to developer activity while tasks are running
> Parent: `2026-06-23-wave-event-forwarding-spec.md` (Approach A, post-task forwarding)
> Upgrade: Approach A → Approach B (real-time forwarding)

## Problem

Approach A (already implemented) forwards worktree events to the main EventBus **after the task completes**. This means during a 5-10 minute developer run, the dashboard shows nothing — no live output, no heartbeat, no "which agent is running". Events only appear after the task finishes.

The operator needs to see developer activity **in real time** during wave mode, just like serial mode.

## Goal

Forward worktree role-level events to the main EventBus **in real time** while the task is running, not after it completes.

## Implementation

### 1. Pass mainEventBus into runTaskGraphTaskSerial

**File**: `src/orchestrator/task-graph-loop.ts`

`runTaskGraphTaskSerial()` creates its own `EventBus` for the worktree. Instead, accept an optional `mainEventBus: IEventBus` parameter and use it **alongside** the worktree's own EventBus.

The worktree needs its own EventBus for writing to the worktree's `events.jsonl` (for per-task archive). But it also needs to forward to the main EventBus for real-time dashboard visibility.

**Approach**: In `runTaskGraphTaskSerial`, after creating the worktree EventBus, subscribe to it and forward relevant events to `mainEventBus`:

```ts
// Inside runTaskGraphTaskSerial, after creating worktree EventBus:
if (mainEventBus) {
  worktreeEventBus.subscribe((event) => {
    if (FORWARDABLE_KINDS.has(event.kind)) {
      void mainEventBus.emit({
        kind: event.kind,
        phase: event.phase,
        level: event.level,
        message: `[${taskId}] ${event.message}`,
        role: event.role,
        task_id: taskId,
        provider: event.provider,
        model: event.model,
        status: event.status,
        duration_ms: event.duration_ms,
        exit_code: event.exit_code,
        artifact_refs: event.artifact_refs,
        payload: event.payload,
      }).catch(() => { /* fail-soft */ });
    }
  });
}
```

This is real-time — the subscriber fires immediately when the worktree EventBus emits, which happens when the developer agent produces output or heartbeat.

### 2. Thread mainEventBus through the call chain

**File**: `src/orchestrator/task-graph-worktree-runner.ts`

`runTaskInWorktree()` calls `runTaskGraphTaskSerial()`. Add `mainEventBus` to `RunTaskInWorktreeParams` (already done) and pass it through:

```ts
const taskExecution = await runTaskGraphTaskSerial({
  // ... existing params ...
  eventBus: worktreeEventBus,  // worktree's own bus (for worktree events.jsonl)
  mainEventBus: params.mainEventBus,  // main bus (for real-time forwarding)
});
```

**File**: `src/orchestrator/task-graph-loop.ts`

`runTaskGraphTaskSerial` interface needs to accept `mainEventBus`:

```ts
interface TaskGraphTaskSerialParams {
  // ... existing fields ...
  mainEventBus?: IEventBus;
}
```

### 3. Remove post-task forwarding (Approach A)

**File**: `src/orchestrator/task-graph-worktree-runner.ts`

Remove the `forwardWorktreeEvents()` call and function — it's no longer needed since events are forwarded in real time via the subscriber.

### 4. Dashboard: handle parallel task events

**File**: `src/web/dashboard-html.ts`

The live output panel should show `[task-id]` prefix when events have `task_id`. The agent status panel should show which task each agent belongs to when in wave mode (multiple developer role.started events with different task_ids).

No new API endpoint needed — the existing SSE stream already pushes these events in real time.

### 5. Forwardable event kinds

Same as Approach A:

```ts
const FORWARDABLE_KINDS = new Set([
  'role.started', 'role.exited', 'role.heartbeat',
  'role.output', 'audit.decision', 'provider.failure',
]);
```

Do NOT forward: task.*, wave.*, integration.*, run.*, verification.* (those are already emitted on the main bus directly).

## Edge Cases

1. **Multiple parallel tasks**: Each task's worktree EventBus subscriber forwards independently. The dashboard sees interleaved events with `task_id` to distinguish them.

2. **Retry resets worktree**: When `resetWorktreeToBase` runs between retries, the worktree EventBus is recreated. The subscriber from the previous attempt is garbage-collected. The new attempt creates a fresh subscriber. No leak.

3. **Worktree EventBus emit fails**: The forwarding uses `void mainEventBus.emit(...).catch(() => {})` — fail-soft, never blocks the task.

4. **Very high event rate (heartbeat + output)**: The 500ms throttle on `role.output` (in process-runner) already limits output events. Heartbeat is every 30s. This is manageable.

5. **Task fails before any agent runs**: No events to forward — subscriber simply never fires. No error.

## Testing

### Unit Test

**File**: `tests/unit/worktree-realtime-forward.test.ts` (new)

- Mock worktree EventBus, subscribe to main EventBus.
- Emit role.started on worktree bus → assert main bus receives it with task_id.
- Emit task.started on worktree bus → assert main bus does NOT receive it (not forwardable).
- Emit role.output on worktree bus → assert main bus receives it with [task-id] prefix.

### Integration Test

**File**: `tests/integration/wave-realtime-forward.test.ts` (new)

- Run a wave with 1 task using fake-agent.
- Assert main events.jsonl contains role.started/role.output/role.exited events with task_id DURING the run (not just after).
- Verify events appear in real-time (seq numbers interleaved with task.started/task.completed).

## Files to Touch

| File | Change |
|---|---|
| `src/orchestrator/task-graph-loop.ts` | Accept mainEventBus param, subscribe+forward in runTaskGraphTaskSerial |
| `src/orchestrator/task-graph-worktree-runner.ts` | Pass mainEventBus to runTaskGraphTaskSerial, remove forwardWorktreeEvents |
| `src/web/dashboard-html.ts` | Show task_id prefix in live output for wave mode |
| `tests/unit/worktree-realtime-forward.test.ts` | NEW |
| `tests/integration/wave-realtime-forward.test.ts` | NEW |

## Validation

```bash
npm test -- --run tests/unit/worktree-realtime-forward.test.ts
npm test -- --run tests/integration/wave-realtime-forward.test.ts
npm test -- --run tests/integration/task-graph-parallel-wave.test.ts
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

## Context

- Approach A (post-task): `src/orchestrator/task-graph-worktree-runner.ts` `forwardWorktreeEvents()` — to be removed
- Worktree EventBus creation: `src/orchestrator/task-graph-loop.ts` `runTaskGraphTaskSerial()` — where worktree EventBus is created
- EventBus subscribe: `src/runtime/event-bus.ts` `subscribe(listener)` — returns disposer
- Worktree runner: `src/orchestrator/task-graph-worktree-runner.ts` `runTaskInWorktree()` — already has mainEventBus param
