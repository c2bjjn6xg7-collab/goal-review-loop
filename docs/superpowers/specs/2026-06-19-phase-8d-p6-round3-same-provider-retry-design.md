# Phase 8D P6 Round 3: Same-Provider Developer Retry Budget — Design Spec

> **Status:** Ready for review-loop implementation
> **Requirements:** `docs/superpowers/specs/2026-06-19-phase-8d-p6-round3-same-provider-retry-requirements.md`
> **Scope:** small configuration wiring; no escalation/provider routing.

## Goal

Replace the hard-coded Developer retry budget with `config.loop.max_agent_retries`, and set the default retry budget to 3.

The feature keeps the existing same-provider retry behavior. It only makes the number of retries configurable and changes the default from 1 retry to 3 retries.

## Key Semantics

### `max_agent_retries` Means Retries, Not Total Attempts

`max_agent_retries = 3` means:

```text
attempt 1: initial Developer invocation
attempt 2: retry 1
attempt 3: retry 2
attempt 4: retry 3
```

So total Developer invocations per iteration are `max_agent_retries + 1`.

### Retry Class Remains Narrow

Preserve the current condition:

```ts
developerResult.status === 'failed'
  && developerResult.error?.code === 'AGENT_ERROR'
```

Do not expand this round to `AGENT_TIMEOUT`, validation failures, `BLOCKED` handoff, Auditor FAIL, verification FAIL, or scope FAIL.

### No Escalation

Do not read or consume `escalation_target`. Do not switch models or providers. Every retry uses the same resolved Developer command:

```ts
resolveCommandForAgent(config.agents.developer.command, config.agents.developer.provider, config)
```

## Implementation Details

### 1. Config Defaults

Modify `src/artifacts/config.ts`:

```ts
loop: {
  max_iterations: 3,
  archive_history: true,
  stop_on_infrastructure_error: true,
  max_consecutive_failures: 3,
  max_agent_retries: 3,
},
```

Existing backward-compatible loading already fills from `DEFAULT_CONFIG.loop.max_agent_retries`; changing the default is enough for omitted YAML to backfill `3`.

### 2. Type Comment

Modify `src/types.ts` comment:

```ts
/** Phase 8D P6: same-provider retry budget. Default: 3. */
max_agent_retries: number;
```

Avoid mentioning escalation in the comment. This project does not currently implement provider/model escalation.

### 3. Orchestrator Wiring

Modify `src/orchestrator/run-orchestrator.ts`.

Replace:

```ts
const MAX_DEVELOPER_RETRIES = 1;
for (let developerAttempt = 0; developerAttempt <= MAX_DEVELOPER_RETRIES; developerAttempt++) {
```

with:

```ts
const maxDeveloperRetries = config.loop.max_agent_retries;
for (let developerAttempt = 0; developerAttempt <= maxDeveloperRetries; developerAttempt++) {
```

Replace the retry condition:

```ts
developerAttempt < MAX_DEVELOPER_RETRIES
```

with:

```ts
developerAttempt < maxDeveloperRetries
```

Update the nearby comment from "retry once" to "retry within the configured same-provider budget".

Do not otherwise change the retry loop structure, prompt rebuild behavior, `attempt: developerAttempt + 1`, log naming, or error handling.

### 4. Config Tests

Modify `tests/unit/config.test.ts`:

- Default test should expect `DEFAULT_CONFIG.loop.max_agent_retries === 3`.
- Backfill test should expect omitted `max_agent_retries` loads as `3`.
- Boundary tests remain `1` and `10`.
- Invalid tests remain `0`, `11`, and `1.5`.

### 5. Fake Agent Fixture

Modify `tests/fixtures/fake-agent.mjs` with a new Developer behavior:

```text
developer-fail-three-then-success
```

Behavior:

- Use a sentinel file under `.agent/debug/`, for example `.agent/debug/developer-fail-three-then-success-count`.
- Increment the count every time this fake Developer behavior is invoked.
- For counts `1`, `2`, and `3`, exit nonzero to produce `AGENT_ERROR`.
- On count `4` and later, write a normal completed handoff and a small allowed implementation file, same as the `success` behavior.

This avoids adding a new command-template placeholder and keeps tests close to real retry behavior.

### 6. Integration Tests

Modify `tests/integration/run-orchestrator.test.ts`.

Add two tests:

#### I1. Default `max_agent_retries: 3` allows three failures then success

Setup:

- `developer: 'developer-fail-three-then-success'`
- default loop config (do not override `max_agent_retries`)
- auditor remains `audit-pass`

Assertions:

- result phase is `PASSED`;
- exit code is `0`;
- sentinel count is `4`;
- iteration log contains `developer retry 1`, `developer retry 2`, and `developer retry 3`.

#### I2. Override `max_agent_retries: 2` blocks before fourth invocation

Setup:

- `developer: 'developer-fail-three-then-success'`
- `loopOverrides: { max_agent_retries: 2 }`

Assertions:

- result phase is `BLOCKED`;
- exit code is `3`;
- sentinel count is `3`;
- iteration log contains `developer retry 1` and `developer retry 2`;
- iteration log does not contain `developer retry 3`.

Use the existing `loopOverrides` helper if present. If it is not present in the target branch, add it without changing existing call sites:

```ts
function writeFakeAgentConfig(
  repoDir: string,
  roleBehaviors: Record<string, string>,
  loopOverrides: Record<string, unknown> = {},
): void {
  // ...
  loop: { max_iterations: 3, ...loopOverrides },
}
```

## Expected Test Commands

Run targeted tests first:

```bash
npm test -- --run tests/unit/config.test.ts tests/integration/run-orchestrator.test.ts
```

Then run full gates:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

## Explicit Non-Goals

- Do not change task-graph retry behavior.
- Do not change the P6 Round 2 failure guard.
- Do not change config schema ranges.
- Do not add `max_agent_retries` CLI flags.
- Do not add `{attempt}` to command templates.
- Do not change any `.agent/**` tracked files.
- Do not modify `src/cli/start.ts`; it currently has unrelated local edits in the working tree.

## Review-Loop Request Text

Use this implementation request:

```text
Implement Phase 8D P6 Round 3: same-provider Developer retry budget.

Authoritative docs:
- docs/superpowers/specs/2026-06-19-phase-8d-p6-round3-same-provider-retry-requirements.md
- docs/superpowers/specs/2026-06-19-phase-8d-p6-round3-same-provider-retry-design.md

Hard scope:
- Replace the hard-coded Developer retry budget with config.loop.max_agent_retries.
- Change the default max_agent_retries from 1 to 3.
- Add fake-agent + integration coverage proving default 3 retries and override 2 retries.
- Preserve same-provider behavior; do not implement escalation_target or provider/model switching.

Allowed files:
- src/artifacts/config.ts
- src/types.ts
- src/orchestrator/run-orchestrator.ts
- tests/unit/config.test.ts
- tests/fixtures/fake-agent.mjs
- tests/integration/run-orchestrator.test.ts

Do not touch:
- src/cli/start.ts
- src/orchestrator/task-graph-loop.ts
- src/orchestrator/failure-guard.ts
- src/scheduler/failure-policy.ts
- src/orchestrator/state-store.ts
- prompts/**
- .agent/**

Acceptance:
- Targeted tests pass.
- typecheck, lint --max-warnings 0, build, and full test suite pass.
- Final report explicitly states that no provider/model escalation was implemented.
```

