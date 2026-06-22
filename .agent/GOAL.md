---
schema_version: 1
run_id: "20260622115414-tpkvk3"
goal_id: "phase-9-r6-integration-events-worker-details"
title: "Phase 9 R6 — Integration Events + Task-Graph Worker Details"
allowed_changes:
  - "src/**"
  - "tests/**"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
verification_commands:
  - id: "unit-tests"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Objective

Close the Phase 9 observability gaps in the task-graph (parallel wave) path:

1. **Emit `integration.*` events** (`integration.started`, `integration.completed`, `integration.blocked`) from the task-graph integration phase in `src/orchestrator/task-graph-wave-loop.ts`. These event kinds are already defined in `ReviewLoopEventKind` (`src/runtime/event-store.ts:40-42`) but never emitted — they are dead code.

2. **Add worker details to `task.*` events** in `src/orchestrator/task-graph-wave-loop.ts`:
   - `task.started`: add `provider` and `model` (read from `config.agents.developer`).
   - `task.completed` / `task.blocked`: add `worktree_path` to the payload (data already available as `RunTaskInWorktreeResult.worktreePath`).

# Success Criteria

1. **`integration.started` is emitted** from `runTaskGraphWaveLoop` after `buildIntegrationPlan` succeeds and before the excluded-tasks check, with payload `{ integration_branch: string, task_count: number }`. `integration_branch` equals `integration/{run_id}`. `task_count` equals `integrationPlan.tasks.length`.

2. **`integration.completed` is emitted** from `mapIntegrationAuditResult` when `finalization.status === 'passed'`, with payload `{ integration_branch: string }`. It is emitted before the final `return` and does not change the return value.

3. **`integration.blocked` is emitted** at each of the 4 blocked return points in the integration phase:
   - Excluded-tasks early return (lines ~269-320).
   - Merge-blocked early return (lines ~330-370).
   - Audit-blocked return in `mapIntegrationAuditResult` (lines ~452-499).
   - Finalization-blocked return in `mapIntegrationAuditResult` (lines ~521-560).
   Each emit has payload `{ integration_branch: string, error: string }`.

4. **All `integration.*` emits are fail-soft.** They use `void eventBus.emit({...}).catch(() => { /* fail-soft */ })` (mirroring the existing `wave.*` emit pattern at lines 131-137). An emit failure does not change scheduling state, does not throw, and does not prevent the orchestrator from reaching its correct terminal phase.

5. **`task.started` events include `provider`** set to `config.agents.developer.provider ?? 'claude'` (mirroring `role.started` at `run-orchestrator.ts:1300`).

6. **`task.started` events include `model`** set to `config.agents.developer.model` when that field is configured. `AgentConfig` in `src/types.ts` gains an optional `model?: string` field to source this. When `model` is not configured, the field is `undefined` and omitted from the serialized event.

7. **`task.completed` and `task.blocked` events include `worktree_path`** in `payload`, set to `result.worktreePath` from `RunTaskInWorktreeResult`. The value is a non-empty string for every task that went through the worktree runner.

8. **Integration test passes:** a new (or extended) test in `tests/integration/` runs a 3-task parallel wave with `fake-agent` 'task-success' and asserts via `EventStore.readAll()`:
   - `integration.started` exists with `payload.integration_branch === 'integration/{run_id}'` and `payload.task_count === 3`.
   - `integration.completed` exists with `payload.integration_branch === 'integration/{run_id}'`.
   - `integration.started` seq < `integration.completed` seq < `run.completed` seq.
   - 3 `task.started` events each have a string `provider` field.
   - 3 `task.completed` events each have `payload.worktree_path` as a non-empty string.

9. **No-spurious-events test passes:** a task-graph run where a task fails (so the wave returns BLOCKED before the integration phase) asserts that no `integration.*` events are emitted, and that `task.blocked` events still carry `payload.worktree_path`.

10. **No regression:** `npm test` passes in full. Existing tests — especially `tests/integration/task-graph-parallel-wave.test.ts`, `tests/integration/orchestrator-events.test.ts`, `tests/integration/integration-runner.test.ts`, `tests/integration/integration-finalizer.test.ts`, `tests/unit/event-store.test.ts`, `tests/unit/event-bus.test.ts` — continue to pass without modification (or with only additive assertions).

# Non-Goals

- Do NOT touch the serial path (`src/orchestrator/run-orchestrator.ts`) integration logic.
- Do NOT change the `ReviewLoopEventKind` enum or the `ReviewLoopEvent` / `EventDraft` core schema fields in `src/runtime/event-store.ts`. The `integration.*` kinds already exist.
- Do NOT change `review-loop.yaml`.
- Do NOT thread `eventBus` into `integration-runner.ts` or `integration-finalizer.ts`. The wave-loop is the integration-phase orchestrator and already holds `eventBus`; emits happen at the wave-loop level.
- Do NOT implement R11 next-action events or R5/R12 artifact refs — those are handled on another branch.
- Do NOT add new npm dependencies.
- Do NOT build a web dashboard or new CLI commands.

# Constraints

- TypeScript, reuse the existing build (`npm run build` / `tsc --noEmit`).
- Reuse `EventStore` / `IEventBus` — do not reimplement event persistence.
- Fail-soft: `integration.*` emits must never affect scheduling. Use the existing `void eventBus.emit(...).catch(() => {})` pattern.
- All new tests must use the existing `fake-agent.mjs` fixture pattern and `EventStore.readAll()` for assertions — no new test infrastructure.
- `AgentConfig.model` is the only schema addition allowed, and it must be optional.
- Emit ordering: `integration.started` must precede `integration.completed` / `integration.blocked` in seq order. `integration.completed` must precede `run.completed`.
