# Phase 8D P6 Round 3: Same-Provider Developer Retry Budget — Requirements

> **Status:** Ready for implementation
> **Predecessors:** P6 Round 1 (`14ed2f2`) added `loop.max_agent_retries`; P6 Round 2 (`3738dae`) wired the consecutive failure guard.
> **Implementation owner:** review-loop plugin run, using the companion design spec as authoritative.

## User Requirement

Developer execution should retry **three times by default** when the Developer agent fails to run successfully for transient/provider-style reasons.

This is **not** a model-upgrade or provider-routing feature. Retries must invoke the same configured Developer command/provider each time. In the user's intended setup, that means the configured domestic execution model remains the execution path for every retry.

## Definitions

- **Initial attempt:** the first Developer agent invocation in an iteration.
- **Retry:** an additional Developer agent invocation after a retryable Developer execution failure.
- **`max_agent_retries`:** number of retry attempts after the initial attempt.
- **Default desired behavior:** `max_agent_retries = 3`, which means up to **4 total Developer invocations** per iteration: initial attempt + 3 retries.
- **Same-provider retry:** retrying the same `config.agents.developer.command` / provider configuration. No automatic fallback or model switching.

## Current State

The code already has same-provider Developer retry behavior, but the retry budget is hard-coded:

- `src/orchestrator/run-orchestrator.ts` defines `MAX_DEVELOPER_RETRIES = 1`.
- The retry condition only retries Developer failures where `developerResult.status === 'failed'` and `developerResult.error?.code === 'AGENT_ERROR'`.
- `src/types.ts` and `src/artifacts/config.ts` already include `loop.max_agent_retries`, but `run-orchestrator.ts` does not consume it.
- The current default is `max_agent_retries: 1`.

## Required Behavior

1. `DEFAULT_CONFIG.loop.max_agent_retries` must become `3`.
2. Loading older YAML that omits `max_agent_retries` must backfill `3`.
3. `run-orchestrator.ts` must use `config.loop.max_agent_retries` instead of the hard-coded `1`.
4. The retry condition must preserve current semantics:
   - retry only the Developer agent;
   - retry only same-provider/same-command;
   - retry only the existing retryable failure class (`AGENT_ERROR`);
   - do not retry Auditor FAIL, verification FAIL, scope FAIL, or Developer `BLOCKED` handoff.
5. `max_agent_retries = N` means:
   - total attempts = `N + 1`;
   - retry labels remain `retry 1`, `retry 2`, ...;
   - Developer adapter `attempt` remains 1-indexed (`attempt: developerAttempt + 1`).

## Non-Goals

- No `escalation_target` consumption.
- No automatic provider/model escalation.
- No fallback from domestic execution model to GPT/Claude/other providers.
- No task-graph retry semantic changes.
- No changes to `max_iterations` rework semantics.
- No changes to the consecutive failure guard from P6 Round 2.
- No Planner/Auditor/FinalAuditor retry budget changes.
- No command-template `{attempt}` placeholder.

## Acceptance Criteria

1. Default config exposes `max_agent_retries: 3`.
2. Backward-compatible config loading fills omitted `max_agent_retries` as `3`.
3. A fake Developer that fails three times with `AGENT_ERROR` and succeeds on the fourth invocation passes with default config.
4. The same fake Developer blocks when `max_agent_retries: 2`, proving config controls the retry budget.
5. Existing boundary validation remains intact: valid range is integer `1..10`.
6. No automatic provider escalation is introduced; `escalation_target` remains unused.
7. Engineering gates pass:
   - `npm run typecheck`
   - `npm run lint -- --max-warnings 0`
   - `npm run build`
   - `npm test -- --run`

## Files Expected To Change

- `src/artifacts/config.ts`
- `src/types.ts`
- `src/orchestrator/run-orchestrator.ts`
- `tests/unit/config.test.ts`
- `tests/fixtures/fake-agent.mjs`
- `tests/integration/run-orchestrator.test.ts`

## Files That Must Not Change

- `src/orchestrator/task-graph-loop.ts`
- `src/orchestrator/failure-guard.ts`
- `src/scheduler/failure-policy.ts`
- `src/orchestrator/state-store.ts`
- `src/cli/**`
- `prompts/**`
- `.agent/**`

