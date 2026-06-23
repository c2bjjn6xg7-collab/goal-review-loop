# Wave Mode Worktree Event Forwarding

> Date: 2026-06-23
> Status: Spec — ready for review-loop implementation
> Priority: High — dashboard is blind to developer/auditor activity in wave mode

## Problem

In **wave parallel mode**, each task runs in an isolated git worktree (`src/orchestrator/task-graph-worktree-runner.ts`). The worktree has its own `.agent/` directory with its own `events.jsonl`. The developer and auditor agents emit `role.started`/`role.exited`/`role.heartbeat`/`role.output`/`audit.decision` events into the **worktree's** event stream.

The **main repository's** `events.jsonl` (what the dashboard reads) only gets `task.started`/`task.completed`/`task.blocked`/`wave.started`/`wave.completed` events. It never sees which agent is running, what model is used, live output, heartbeats, or audit decisions inside a task.

**Result:** The dashboard shows "task-1 started" then nothing for 5-10 minutes while the developer runs, then "task-1 completed". The operator cannot see live agent output, heartbeats, or which agent is active — defeating the purpose of R5-Live real-time output in wave mode.

## Goal

Forward task-internal events (role.started, role.exited, role.heartbeat, role.output, audit.decision, provider.failure) from each worktree's event stream to the main repository's event bus, so the dashboard sees full agent activity even in wave mode.

## Non-Goals

- Do not change worktree isolation (each task still runs in its own worktree).
- Do not merge worktree event files into the main events.jsonl (that would mix run_ids and break per-run isolation).
- Do not forward task-level events (task.started/completed — those already go to the main bus).
- Do not forward verification events from worktrees (verification runs in the main repo after wave completion).
- Do not change serial mode (serial mode already emits to the main bus directly).

## Implementation

### 1. Pass the main EventBus into runTaskInWorktree

**File**: `src/orchestrator/task-graph-worktree-runner.ts`

Currently `runTaskInWorktree()` receives a `params` object but does NOT have access to the main repository's EventBus. Add an optional `mainEventBus: IEventBus` parameter.

The main EventBus is available in `task-graph-wave-loop.ts` (it's destructured from `TaskGraphWaveLoopParams`). Thread it through the `runTask` callback into `runTaskInWorktree()`.

### 2. Forward events from worktree to main bus

**File**: `src/orchestrator/task-graph-worktree-runner.ts`

Inside `runTaskInWorktree()`, after the task's serial loop runs (which writes to the worktree's own `.agent/events.jsonl`), forward relevant events to the main bus.

**Approach A (simplest — recommended):** Read the worktree's events.jsonl after the task completes and forward the role-level events:

```ts
// After runTaskGraphTaskSerial completes:
if (mainEventBus && result.status !== 'cancelled') {
  const worktreeEventsPath = path.join(worktreeAgentDir, 'events.jsonl');
  if (existsSync(worktreeEventsPath)) {
    const store = new EventStore(worktreeAgentDir, runId);
    const events = await store.readAll();
    const forwardKinds = new Set([
      'role.started', 'role.exited', 'role.heartbeat',
      'role.output', 'audit.decision', 'provider.failure',
    ]);
    for (const ev of events) {
      if (forwardKinds.has(ev.kind)) {
        await mainEventBus.emit({
          kind: ev.kind,
          phase: ev.phase,
          level: ev.level,
          message: `[${task.id}] ${ev.message}`,
          role: ev.role,
          task_id: task.id,
          wave_index: waveIndex,
          provider: ev.provider,
          model: ev.model,
          status: ev.status,
          duration_ms: ev.duration_ms,
          exit_code: ev.exit_code,
          artifact_refs: ev.artifact_refs,
          payload: ev.payload,
        });
      }
    }
  }
}
```

**Important:** Prefix the message with `[task-id]` so the dashboard can distinguish which task's agent is reporting. Add `task_id` and `wave_index` to the forwarded event so the dashboard can group by task.

**Approach B (real-time — more complex):** Subscribe to the worktree's EventBus in real-time and forward as events happen. This requires the worktree's `runTaskGraphTaskSerial` to accept and use an EventBus (it currently creates its own). This is more invasive but gives true real-time forwarding.

**Recommendation:** Start with Approach A (post-task forwarding). It's simple, low-risk, and the dashboard will show the full event history after each task completes. If real-time forwarding is needed later, upgrade to Approach B.

### 3. Dashboard: show task-scoped agent events

**File**: `src/web/dashboard-html.ts`

The forwarded events now have `task_id` and `wave_index` fields. The dashboard should:

- In the event timeline, show `[task-1] Developer starting` style messages.
- In the agent status panel, when multiple tasks are running in parallel, show which task each agent belongs to (e.g., "Developer (task-1)" and "Developer (task-2)").
- In the live output panel, prefix lines with the task ID when in wave mode.

No new API endpoint needed — the existing `/api/events` and SSE stream already return these events (they now have `task_id`/`wave_index` fields).

### 4. Event deduplication

The main bus might receive duplicate events if a task is retried (the worktree events.jsonl accumulates across retries). Forward only events from the **latest** attempt. Since `resetWorktreeToBase` clears the worktree between retries (including `.agent/events.jsonl`), this should be handled automatically — each retry starts with a fresh worktree event stream.

Verify this in the implementation: after `resetWorktreeToBase`, confirm the worktree's `events.jsonl` is deleted/reset.

## Testing

### Integration Test

**File**: `tests/integration/wave-event-forwarding.test.ts` (new)

- Run a wave with 2 tasks using fake-agent.
- Assert the main repository's `events.jsonl` contains `role.started`/`role.exited` events with `task_id` set.
- Assert the forwarded events have `[task-id]` prefix in the message.
- Assert no duplicate events after retry (if retry is triggered).

### Unit Test

**File**: `tests/unit/task-graph-worktree-runner-forward.test.ts` (new)

- Mock `runTaskGraphTaskSerial` to produce a worktree with `events.jsonl` containing role events.
- Call `runTaskInWorktree` with `mainEventBus`.
- Assert `mainEventBus.emit` was called with the forwarded events.
- Assert only forwardable kinds are forwarded (not task.* or wave.*).
- Assert `task_id` and `wave_index` are set on forwarded events.

## Files to Touch

| File | Change |
|---|---|
| `src/orchestrator/task-graph-worktree-runner.ts` | Add `mainEventBus` param + forward worktree events after task |
| `src/orchestrator/task-graph-wave-loop.ts` | Pass `eventBus` into `runTaskInWorktree` call |
| `src/web/dashboard-html.ts` | Show task_id prefix in timeline + agent panel for wave mode |
| `tests/integration/wave-event-forwarding.test.ts` | NEW |
| `tests/unit/task-graph-worktree-runner-forward.test.ts` | NEW |

## Edge Cases

1. **Worktree has no events.jsonl** (task failed before any agent ran): Skip forwarding, no error.
2. **Multiple tasks in same wave**: Each task's events forwarded independently. `task_id` distinguishes them.
3. **Retry clears worktree**: After `resetWorktreeToBase`, worktree's events.jsonl is gone. Next attempt creates fresh events. Only the final attempt's events are forwarded.
4. **Very large worktree event stream**: Cap forwarded events to the last 100 role events per task to avoid flooding the main stream.
5. **Archived run browsing**: Forwarded events are already in the main events.jsonl, so archived runs include them automatically.

## Validation

```bash
npm test -- --run tests/unit/task-graph-worktree-runner-forward.test.ts
npm test -- --run tests/integration/wave-event-forwarding.test.ts
npm test -- --run tests/integration/task-graph-parallel-wave.test.ts
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

## Context

- Wave runner: `src/orchestrator/task-graph-worktree-runner.ts` `runTaskInWorktree()`
- Wave loop: `src/orchestrator/task-graph-wave-loop.ts` (has `eventBus` in scope)
- EventStore: `src/runtime/event-store.ts` (readAll, readSince)
- EventBus: `src/runtime/event-bus.ts` (emit, IEventBus interface)
- Dashboard: `src/web/dashboard-html.ts` (event timeline, agent panel, live output)
- R5-Live: `src/runtime/output-filter.ts`, `src/agents/agent-adapter.ts` (role.output/heartbeat emission)
