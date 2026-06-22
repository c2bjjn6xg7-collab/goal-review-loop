---
schema_version: 1
run_id: "20260622115414-tpkvk3"
author_role: "planner"
---

# Phase 9 Observability Gap Fill — R6 Integration Events + Task-Graph Worker Details

## Requirement Understanding

The user wants to close two observability gaps in the Phase 9 event stream for
the task-graph (parallel wave) path:

1. **Emit `integration.*` events.** `ReviewLoopEventKind` already defines
   `integration.started`, `integration.completed`, and `integration.blocked`
   (`src/runtime/event-store.ts:40-42`), but nothing emits them. They are dead
   code. The task-graph integration phase runs inside
   `src/orchestrator/task-graph-wave-loop.ts` (it calls `buildIntegrationPlan`
   → `runIntegrationMerge` → `runIntegrationAudit` → `runIntegrationFinalization`).
   We must emit:
   - `integration.started` with payload `{ integration_branch, task_count }` when the integration phase begins.
   - `integration.completed` with payload `{ integration_branch }` when the whole integration+audit+finalization succeeds.
   - `integration.blocked` with payload `{ error }` at every blocked return point in the integration phase (excluded-tasks, merge-blocked, audit-blocked, finalization-blocked).
   - All emits must be fail-soft (must not change scheduling state).

2. **Add worker details to `task.*` events.** `task-graph-wave-loop.ts` already
   emits `task.started` (lines 151-159) and `task.completed`/`task.blocked`
   (lines 186-195). The `task.completed` payload has `worker_branch` but is
   missing `worktree_path`. The `task.started` event is missing `provider` and
   `model`. We must:
   - Add `provider` (and `model` when configured) to `task.started`, reading from `config.agents.developer` (mirroring the `role.started` pattern at `run-orchestrator.ts:1300`).
   - Add `worktree_path` to the `task.completed` and `task.blocked` payloads. The data already exists as `RunTaskInWorktreeResult.worktreePath` (`task-graph-worktree-runner.ts:47`) and is returned to the wave-loop — no type change needed for that field.

### Explicit non-goals (from user)
- Do NOT touch the serial path (`run-orchestrator.ts`) integration logic.
- Do NOT change the event schema core fields (`integration.*` are already defined in `ReviewLoopEventKind`).
- Do NOT change `review-loop.yaml`.
- Do NOT do R11 next-action or R5/R12 artifact refs (handled elsewhere).

## Current Project Status

### What exists
- `src/runtime/event-store.ts` — `EventStore` (append-only JSONL) + `ReviewLoopEventKind` enum including `integration.started|completed|blocked` (lines 40-42). `EventDraft` supports `provider`, `model`, `task_id`, `wave_index`, `payload` (lines 93-108).
- `src/runtime/event-bus.ts` — `IEventBus` interface + `EventBus` class with fail-soft `emit()` (lines 48-77) and `EventBus.createNull()` for tests (lines 92-99).
- `src/orchestrator/task-graph-wave-loop.ts` — the wave-loop. Already has `eventBus: IEventBus` in params (line 68) and emits `wave.started|completed` (lines 130-137), `task.started` (lines 151-159), `task.completed|blocked` (lines 186-195). The integration phase spans lines 263-407 (plan → merge → audit → finalize).
- `src/orchestrator/task-graph-worktree-runner.ts` — `RunTaskInWorktreeResult` already includes `worktreePath: string` (line 47). The wave-loop's `runTask` callback receives this result (line 161-174) but only reads `result.branch` and `result.error` when building the event payload (line 194).
- `src/orchestrator/integration-runner.ts` / `integration-finalizer.ts` — the R1/R3 integration modules. They do NOT take `eventBus` (the user noted this). We will NOT thread `eventBus` through them — see Technical Approach.
- `src/types.ts` — `AgentConfig` (lines 446-450) has `command`, `timeout_seconds`, `provider?`. No `model?` field.
- `tests/integration/task-graph-parallel-wave.test.ts` — existing happy-path wave test using `fake-agent.mjs`. Pattern: create test repo, run orchestrator with `parallel: true`, assert on `.agent/events.jsonl` via `EventStore.readAll()`.
- `tests/integration/orchestrator-events.test.ts` — existing event-stream assertion patterns (lines 92-118).

### What's missing
- No `integration.*` emits anywhere (dead code in the enum).
- `task.started` has no `provider`/`model`.
- `task.completed`/`task.blocked` payload has no `worktree_path`.
- `AgentConfig` has no `model?` field (needed to source `model` for `task.started`).

## Technical Approach

### Decision: emit `integration.*` from the wave-loop, not from runner/finalizer

The user's hint ("integration-runner.ts 和 integration-finalizer.ts 目前可能没有 eventBus 参数——需要传入") is conditional. After grepping the integration phase boundaries, the wave-loop is the single orchestrator of the integration phase and already holds `eventBus`. It sees every blocked/passed return point:

| Blocked point | Location in wave-loop | Emit |
| --- | --- | --- |
| Integration phase start | After `buildIntegrationPlan` (line 268), before excluded-tasks check | `integration.started` |
| Excluded-tasks block | Lines 269-320 (early return) | `integration.blocked` |
| Merge blocked | Lines 330-370 (early return) | `integration.blocked` |
| Audit blocked | `mapIntegrationAuditResult` lines 452-499 | `integration.blocked` |
| Finalization blocked | `mapIntegrationAuditResult` lines 521-560 | `integration.blocked` |
| Finalization passed | `mapIntegrationAuditResult` end (lines 562-587) | `integration.completed` |

Threading `eventBus` into `integration-runner.ts` and `integration-finalizer.ts` would expand the blast radius (3 module signatures + their callers + their unit tests) for no observability gain — the wave-loop already has the branch/error context at each return point. **We emit from the wave-loop.** This keeps the change atomic and the blast radius small.

### `integration.started` emit point

Emit immediately after `buildIntegrationPlan` succeeds (around line 268), before the excluded-tasks check. At that point we know:
- `integration_branch` = `integrationPlan.integration_branch` (always `integration/{run_id}`).
- `task_count` = `integrationPlan.tasks.length` (selected/non-excluded tasks).

If excluded_tasks > 0, we still emit `integration.started` then immediately `integration.blocked` — that reflects reality.

### `integration.completed` emit point

Emit at the end of `mapIntegrationAuditResult` when `finalization.status === 'passed'`, right before the final `return` (around line 571). Payload: `{ integration_branch: integrationAuditResult.integration_branch }`.

### `integration.blocked` emit points

At each of the 4 blocked return points listed above. Payload: `{ integration_branch, error: <message> }` where `<message>` is the existing error message string used in `makeResult`/`makeBlockedResult` at that point.

### Fail-soft pattern

All emits use the existing `void eventBus.emit({...}).catch(() => { /* fail-soft */ })` pattern (mirroring lines 131-137). Emit failures must not change scheduling state — `eventBus.emit` already swallows persistence errors internally (`event-bus.ts:52-64`), but we add `.catch()` at the call site too for defense-in-depth.

### `task.started` provider/model

At lines 151-159, add:
```ts
provider: config.agents.developer.provider ?? 'claude',
model: config.agents.developer.model,  // undefined if not configured → omitted from JSON
```
This mirrors `role.started` at `run-orchestrator.ts:1300`. Requires adding `model?: string` to `AgentConfig` in `src/types.ts:446-450`.

### `task.completed`/`task.blocked` worktree_path

At lines 186-195, change the payload to include `worktree_path: result.worktreePath`. The `result` variable (line 161) is `RunTaskInWorktreeResult` which has `worktreePath: string` (line 47 of worktree-runner). No type change needed.

### Tests

1. **Happy-path integration event test** — new test file `tests/integration/task-graph-integration-events.test.ts` (or extend `task-graph-parallel-wave.test.ts`). Runs a 3-task parallel wave with `fake-agent` 'task-success'. Asserts via `EventStore.readAll()`:
   - `integration.started` exists with `payload.integration_branch === 'integration/{run_id}'` and `payload.task_count === 3`.
   - `integration.completed` exists with `payload.integration_branch === 'integration/{run_id}'`.
   - `integration.started` seq < `integration.completed` seq.
   - `task.started` events (3) each have `provider` field (string).
   - `task.completed` events (3) each have `payload.worktree_path` (non-empty string).
   - `run.completed` is the last event.

2. **Task-fail / no-spurious-integration-events test** — runs a task-graph where one task fails. Asserts:
   - No `integration.*` events emitted (integration phase never reached).
   - `task.blocked` event has `payload.worktree_path`.

3. **`integration.blocked` stretch goal** — a cherry-pick conflict scenario is complex to fixture (fake-agent behavior is per-role, not per-task). The emit code is symmetric to `integration.completed` and will be covered by code review. If a conflict fixture is straightforward, add it; otherwise note as follow-up.

### Build/test
- TypeScript build: `npm run build` (or `tsc --noEmit`).
- Tests: `npm test` (vitest). The new test file is picked up automatically.

## Work Breakdown

### Task 1: Emit `integration.*` events in wave-loop + integration event test
- Modify `src/orchestrator/task-graph-wave-loop.ts`:
  - After `buildIntegrationPlan` (line 268): emit `integration.started` with `{ integration_branch, task_count }`.
  - At the 4 blocked return points (excluded-tasks, merge-blocked, audit-blocked, finalization-blocked): emit `integration.blocked` with `{ integration_branch, error }` (fail-soft).
  - At the finalization-passed return (end of `mapIntegrationAuditResult`): emit `integration.completed` with `{ integration_branch }` (fail-soft).
- Add test in `tests/integration/task-graph-integration-events.test.ts`:
  - Happy path: assert `integration.started` + `integration.completed` present with correct payload.
  - Task-fail path: assert no `integration.*` events.

### Task 2: Add `provider`/`model` to `task.started` + `worktree_path` to `task.completed`/`task.blocked`
- Modify `src/types.ts`: add `model?: string` to `AgentConfig` (line 446-450).
- Modify `src/orchestrator/task-graph-wave-loop.ts`:
  - `task.started` emit (lines 151-159): add `provider: config.agents.developer.provider ?? 'claude'` and `model: config.agents.developer.model`.
  - `task.completed`/`task.blocked` emit (lines 186-195): add `worktree_path: result.worktreePath` to payload.
- Add/extend test to assert `provider` on `task.started` and `worktree_path` on `task.completed`/`task.blocked`.

### Task 3: Full-suite verification
- Run `npm test` to ensure no regressions across all existing tests (especially `task-graph-parallel-wave.test.ts`, `orchestrator-events.test.ts`, `integration-runner.test.ts`, `integration-finalizer.test.ts`).

## Risks

1. **`integration.blocked` test coverage.** A dedicated cherry-pick-conflict test is complex to fixture (fake-agent behavior is per-role). The emit code is symmetric to `integration.completed` and will be covered by the happy-path test (for `started`/`completed`) plus code review. Risk: low — the emit logic is a 3-line `void eventBus.emit(...).catch(() => {})` at each blocked return, identical to the existing `wave.*` emit pattern.

2. **`task_count` semantics.** The user said "task_count" without specifying total vs selected. We'll use `integrationPlan.tasks.length` (selected count). If the reviewer wants total, it's a 1-character change. Risk: low.

3. **`model` field on `AgentConfig`.** Adding `model?: string` is backward-compatible (optional). Existing configs without `model` continue to work; the `task.started` event will omit `model` (undefined). Risk: low.

4. **Event ordering in wave mode.** Concurrent workers emit `task.*` events in parallel. `EventStore` already serializes appends via `appendChain` (lines 119-180 of event-store.ts) so seq values are monotonic. `integration.*` events are emitted from the single wave-loop coroutine after all workers finish — no concurrency. Risk: low.

5. **Fail-soft invariant.** The user requires `integration.*` emits to not affect scheduling. The `eventBus.emit` already swallows persistence errors (`event-bus.ts:52-64`). We add `.catch(() => {})` at each call site for defense-in-depth. Risk: low.

6. **Not threading `eventBus` into `integration-runner.ts`/`integration-finalizer.ts`.** The user's hint suggested this might be needed. We deliberately don't, because the wave-loop is the integration-phase orchestrator and already has `eventBus`. If a future requirement asks for finer-grained events inside R1/R3 (e.g., per-cherry-pick events), we'd thread it then. Risk: low — documented as a design choice.

```ReviewLoopRequest
type: risk_note
origin_agent: planner
priority: medium
message: integration.blocked emit is not covered by a dedicated integration test; relies on code symmetry with integration.completed and the existing integration-runner.test.ts conflict test.
target: planner
question: Should we add a dedicated cherry-pick-conflict integration test that asserts integration.blocked is emitted at the wave-loop level, or accept code-symmetry coverage for this round?
blocking: false
```
