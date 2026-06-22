---
schema_version: 1
run_id: "20260622115414-tpkvk3"
iteration: 4
author_role: "auditor"
decision: "FAIL"
audited_goal_digest: "sha256:aede263fc20b913819f177bca9a767d28ba8b478553e20c2e90e03f18f43c401"
audited_diff_digest: "sha256:283356fec63b986692f94a7a9fe31851a42cfd515e5c0821677215800f7e7d3a"
---

# Decision

FAIL. The implementation adds the broad integration event flow and the full-suite verification manifest is green, but two required event contracts are not met: every `integration.blocked` payload omits the required `error` string, and `task.started` writes `provider`/`model` under `payload` instead of the event-level fields defined by the event schema and used by the existing `role.started` pattern.

Digest verification:

- GOAL digest: `sha256:aede263fc20b913819f177bca9a767d28ba8b478553e20c2e90e03f18f43c401`
- Diff digest: `sha256:283356fec63b986692f94a7a9fe31851a42cfd515e5c0821677215800f7e7d3a`

# Success Criteria Review

| Criterion | Result | Evidence |
|---|---:|---|
| 1. `integration.started` is emitted after `buildIntegrationPlan` succeeds and before the excluded-tasks check, with `{ integration_branch, task_count }`. | PASS | `buildIntegrationPlan` completes at `src/orchestrator/task-graph-wave-loop.ts:276`; `integrationBranch` is sourced from `integrationPlan.integration_branch` at `src/orchestrator/task-graph-wave-loop.ts:282`; the fail-soft `integration.started` emit with `integration_branch` and `task_count: integrationPlan.tasks.length` is at `src/orchestrator/task-graph-wave-loop.ts:283` to `src/orchestrator/task-graph-wave-loop.ts:292`; the excluded-tasks check starts afterward at `src/orchestrator/task-graph-wave-loop.ts:293`. |
| 2. `integration.completed` is emitted from `mapIntegrationAuditResult` when finalization passed, before the final return, without changing the return value. | PASS | After the finalization blocked branch, the passed path emits progress at `src/orchestrator/task-graph-wave-loop.ts:630` to `src/orchestrator/task-graph-wave-loop.ts:637`, emits `integration.completed` with `integration_branch` at `src/orchestrator/task-graph-wave-loop.ts:639` to `src/orchestrator/task-graph-wave-loop.ts:647`, then returns the existing `makeResult` tuple at `src/orchestrator/task-graph-wave-loop.ts:649` to `src/orchestrator/task-graph-wave-loop.ts:664`. |
| 3. `integration.blocked` is emitted at all 4 blocked return points with payload `{ integration_branch: string, error: string }`. | FAIL | The four emits exist, but their payloads omit `error`: excluded-tasks payload has `integration_branch`, `reason`, and `excluded_task_count` at `src/orchestrator/task-graph-wave-loop.ts:323` to `src/orchestrator/task-graph-wave-loop.ts:333`; merge-blocked payload has `integration_branch` and `reason` at `src/orchestrator/task-graph-wave-loop.ts:384` to `src/orchestrator/task-graph-wave-loop.ts:393`; audit-blocked payload has `integration_branch` and `reason` at `src/orchestrator/task-graph-wave-loop.ts:526` to `src/orchestrator/task-graph-wave-loop.ts:535`; finalization-blocked payload has `integration_branch` and `reason` at `src/orchestrator/task-graph-wave-loop.ts:597` to `src/orchestrator/task-graph-wave-loop.ts:606`. |
| 4. All `integration.*` emits are fail-soft using `void eventBus.emit(...).catch(() => { /* fail-soft */ })`. | PASS | The started, blocked, and completed emits all use the required `void ... .catch(() => { /* fail-soft */ })` pattern at `src/orchestrator/task-graph-wave-loop.ts:283` to `src/orchestrator/task-graph-wave-loop.ts:292`, `src/orchestrator/task-graph-wave-loop.ts:323` to `src/orchestrator/task-graph-wave-loop.ts:333`, `src/orchestrator/task-graph-wave-loop.ts:384` to `src/orchestrator/task-graph-wave-loop.ts:393`, `src/orchestrator/task-graph-wave-loop.ts:526` to `src/orchestrator/task-graph-wave-loop.ts:535`, `src/orchestrator/task-graph-wave-loop.ts:597` to `src/orchestrator/task-graph-wave-loop.ts:606`, and `src/orchestrator/task-graph-wave-loop.ts:639` to `src/orchestrator/task-graph-wave-loop.ts:647`. |
| 5. `task.started` events include event-level `provider` set to `config.agents.developer.provider ?? 'claude'`. | FAIL | The event schema defines `provider` as an event-level field at `src/runtime/event-store.ts:81` and `src/runtime/event-store.ts:102`, and the referenced `role.started` developer pattern uses event-level `provider` at `src/orchestrator/run-orchestrator.ts:1294` to `src/orchestrator/run-orchestrator.ts:1301`. The new task code instead places `provider` inside `payload` at `src/orchestrator/task-graph-wave-loop.ts:151` to `src/orchestrator/task-graph-wave-loop.ts:168`. |
| 6. `task.started` events include event-level `model` from `config.agents.developer.model` when configured, with `AgentConfig.model?: string`. | FAIL | `AgentConfig.model?: string` was added at `src/types.ts:446` to `src/types.ts:450`, but the task event places `model` inside `payload` only when truthy at `src/orchestrator/task-graph-wave-loop.ts:151` to `src/orchestrator/task-graph-wave-loop.ts:168`. The event schema's intended `model` field is event-level at `src/runtime/event-store.ts:82` and `src/runtime/event-store.ts:103`. |
| 7. `task.completed` and `task.blocked` events include `payload.worktree_path` from `result.worktreePath`. | PASS | The shared task terminal emit sets `kind` to `task.completed` or `task.blocked` and includes `worktree_path: result.worktreePath` in `payload` at `src/orchestrator/task-graph-wave-loop.ts:195` to `src/orchestrator/task-graph-wave-loop.ts:207`. |
| 8. Integration test runs a 3-task passing parallel wave and asserts required integration ordering plus task provider/worktree details. | FAIL | The new test creates a passing parallel run at `tests/integration/task-graph-integration-events.test.ts:120` to `tests/integration/task-graph-integration-events.test.ts:132` and asserts `integration.started`/`integration.completed` payloads at `tests/integration/task-graph-integration-events.test.ts:143` to `tests/integration/task-graph-integration-events.test.ts:150`, but it only asserts `started.seq < completed.seq` at `tests/integration/task-graph-integration-events.test.ts:152` to `tests/integration/task-graph-integration-events.test.ts:153`, not `completed.seq < run.completed.seq`. It also asserts `provider` in `payload` at `tests/integration/task-graph-integration-events.test.ts:161` to `tests/integration/task-graph-integration-events.test.ts:165` and uses `toBeGreaterThan(0)` rather than exactly 3 `task.started`/`task.completed` events at `tests/integration/task-graph-integration-events.test.ts:161` to `tests/integration/task-graph-integration-events.test.ts:173`. |
| 9. No-spurious-events test covers a pre-integration task failure and verifies `task.blocked.payload.worktree_path`. | PASS | The failing wave test runs `blocked-handoff` at `tests/integration/task-graph-integration-events.test.ts:177` to `tests/integration/task-graph-integration-events.test.ts:189`, asserts the run blocks at `tests/integration/task-graph-integration-events.test.ts:191` to `tests/integration/task-graph-integration-events.test.ts:192`, asserts no `integration.*` events at `tests/integration/task-graph-integration-events.test.ts:200` to `tests/integration/task-graph-integration-events.test.ts:205`, and asserts non-empty `task.blocked.payload.worktree_path` at `tests/integration/task-graph-integration-events.test.ts:209` to `tests/integration/task-graph-integration-events.test.ts:213`. |
| 10. No regression: `npm test` passes in full. | PASS | Verification manifest reports `passed: true` at `.agent/verification/manifest.json:5`; the required `unit-tests` command is `npm test`, succeeded with exit code 0, and did not time out at `.agent/verification/manifest.json:10` to `.agent/verification/manifest.json:23`. |

# Findings

## High: `integration.blocked` payloads omit the required `error` field

Evidence: All four `integration.blocked` emits omit `payload.error`: excluded-tasks at `src/orchestrator/task-graph-wave-loop.ts:323` to `src/orchestrator/task-graph-wave-loop.ts:333`, merge-blocked at `src/orchestrator/task-graph-wave-loop.ts:384` to `src/orchestrator/task-graph-wave-loop.ts:393`, audit-blocked at `src/orchestrator/task-graph-wave-loop.ts:526` to `src/orchestrator/task-graph-wave-loop.ts:535`, and finalization-blocked at `src/orchestrator/task-graph-wave-loop.ts:597` to `src/orchestrator/task-graph-wave-loop.ts:606`.

Impact: Consumers of the Phase 9 event stream cannot read the required blocked error from `payload.error`, and GOAL criterion 3 is not satisfied for any of the integration blocked paths.

Executable fix requirement: In `src/orchestrator/task-graph-wave-loop.ts`, add an `error` string to each `integration.blocked` payload. Use the existing summary or result message already computed for that blocked return path. Keep the `void eventBus.emit(...).catch(() => { /* fail-soft */ })` pattern and do not change terminal return values.

## High: `task.started` writes `provider` and `model` under `payload` instead of the event-level fields

Evidence: `ReviewLoopEvent` and `EventDraft` define `provider` and `model` as event-level fields at `src/runtime/event-store.ts:81` to `src/runtime/event-store.ts:82` and `src/runtime/event-store.ts:102` to `src/runtime/event-store.ts:103`. The referenced `role.started` developer event sets event-level `provider` at `src/orchestrator/run-orchestrator.ts:1294` to `src/orchestrator/run-orchestrator.ts:1301`. The task-graph code builds `taskStartedPayload` and puts `provider`/`model` inside that payload at `src/orchestrator/task-graph-wave-loop.ts:151` to `src/orchestrator/task-graph-wave-loop.ts:168`.

Impact: Event consumers expecting the schema fields `event.provider` and `event.model` will not see worker details on `task.started` events. This violates GOAL criteria 5 and 6 and makes the new test assert the wrong shape.

Executable fix requirement: Move `provider: config.agents.developer.provider ?? 'claude'` and `model: config.agents.developer.model` to the `eventBus.emit` draft for `task.started`. Keep only task-local details such as `task_index` and `batch_index` in `payload`. Allow `model` to be `undefined` so JSON serialization omits it when not configured.

## Medium: The passing integration test does not assert the full required event contract

Evidence: The test only checks `integration.started.seq < integration.completed.seq` at `tests/integration/task-graph-integration-events.test.ts:152` to `tests/integration/task-graph-integration-events.test.ts:153`, with no assertion that `integration.completed.seq < run.completed.seq`. It validates `provider` in `payload` at `tests/integration/task-graph-integration-events.test.ts:161` to `tests/integration/task-graph-integration-events.test.ts:165`, which is the wrong location for the schema. It also checks that task event counts are greater than zero, not exactly 3, at `tests/integration/task-graph-integration-events.test.ts:161` to `tests/integration/task-graph-integration-events.test.ts:173`.

Impact: The test can pass while criteria 5, 6, and part of criterion 8 remain broken, as this iteration demonstrates.

Executable fix requirement: Update `tests/integration/task-graph-integration-events.test.ts` to assert exactly 3 `task.started` events, exactly 3 `task.completed` events, event-level `provider` on each `task.started`, event-level `model` behavior where configured or explicitly omitted where not configured, and `integration.started.seq < integration.completed.seq < run.completed.seq`.

# Scope Review

Scope is acceptable for the implementation/test paths. GOAL allowed changes under `src/**` and `tests/**` at `.agent/GOAL.md:6` to `.agent/GOAL.md:8`; the business/test changes are limited to `src/orchestrator/task-graph-wave-loop.ts`, `src/types.ts`, and `tests/integration/task-graph-integration-events.test.ts` per `.agent/evidence/iteration-04/changed-files.json:27` to `.agent/evidence/iteration-04/changed-files.json:45`. The scope report passed, allowed those implementation/test paths plus the developer handoff, excluded orchestrator-owned `.agent/GOAL.md` and `.agent/plan.md`, and reported no denied paths or warnings at `.agent/evidence/iteration-04/scope-report.json:2` to `.agent/evidence/iteration-04/scope-report.json:16`.

# Rework Instructions

1. Fix all four `integration.blocked` emits so their payloads include `integration_branch` and an `error` string derived from the existing blocked message/summary for that return path.
2. Move `task.started` worker details to event-level `provider` and `model` fields, leaving `task_index` and `batch_index` in `payload`.
3. Update `tests/integration/task-graph-integration-events.test.ts` to assert the event-level worker fields, exact 3-task event counts, and `integration.completed` before `run.completed`.
4. Run `npm test` and update verification evidence.
