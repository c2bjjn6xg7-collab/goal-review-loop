# Phase 8D P6.5 Auto-run Hardening Design

## Summary

Add a narrow reliability layer for plugin-driven review-loop runs: a task-graph Developer idle watchdog, a lightweight task-scope preflight warning, and prompt guidance for explicit scope-expansion BLOCKED handoffs. The goal is to turn silent stalls into actionable BLOCKED states without changing scheduling, provider routing, or automatic scope decisions.

## Design Decisions

### D1. Watchdog Belongs Below Task Graph, Above Process Runner

The task-graph loop already has task id, attempt number, prompt file, expected handoff, and state/progress context. The process runner already supports `AbortSignal` cancellation and process-tree killing. P6.5 should bridge these by creating a per-task `AbortController`, passing its signal to `runAgent`, and aborting it when the idle watchdog fires.

### D2. Idle Timeout Is Runtime Config

Add `runtime.agent_idle_timeout_seconds`, default `480`.

Validation:

- integer or number accepted by existing config style
- minimum `1`
- backfilled from `DEFAULT_CONFIG.runtime.agent_idle_timeout_seconds`

This keeps test overrides simple and avoids adding CLI flags.

### D3. Stall Result Uses Existing Error Category

Use `AGENT_TIMEOUT`; do not add a new error category. The message should include `idle timeout` so users can distinguish it from the full process timeout.

Suggested message:

```text
Developer stalled on task <task.id> attempt <attempt> after <seconds>s of no output
```

Suggested action:

```text
Inspect stdout/stderr and task prompt; if the task needs files outside allowed_changes, update the task graph or split the task.
```

### D4. Scope Preflight Warns by Default

Create a small helper module instead of embedding rules directly in `task-graph-loop.ts`:

```ts
src/orchestrator/task-graph-preflight.ts
```

Exports:

```ts
export interface TaskGraphPreflightWarning {
  task_id: string;
  code: 'integration_tests_with_tests_only_scope';
  message: string;
}

export function preflightTaskGraphScopes(taskGraph: TaskGraph): TaskGraphPreflightWarning[];
```

Rule:

- Inspect required `verification_commands`.
- If any command argument contains `tests/integration/` or `tests/integration`, and every `allowed_changes` pattern is test-only, warn.
- Test-only patterns include `tests/**`, `tests/...`, and exact `tests/...` files.
- Source-like paths include `src/**`, `prompts/**`, `docs/**`, `review-loop.yaml`, `package.json`, and config files.

The first implementation only logs warnings. It must not block execution.

### D5. Prompt Protocol Is Text Only

Update the task Developer prompt builder/template path so task prompts include:

```text
If you discover that the task requires changes outside allowed_changes, do not edit those files. Instead write developer-handoff.md with status: "BLOCKED" and add a "scope_expansion_request" section listing the needed paths and why they are required.
```

No schema migration in P6.5.

## Components

### 1. Config

Files:

- `src/types.ts`
- `src/artifacts/config.ts`
- `tests/unit/config.test.ts`
- `docs/configuration.md`

Changes:

- Add `runtime.agent_idle_timeout_seconds` to `RuntimeConfig`.
- Add JSON schema property.
- Add default `480`.
- Backfill omitted configs.
- Update tests and docs.

### 2. Idle Watchdog Helper

Create:

```ts
src/orchestrator/developer-idle-watchdog.ts
```

Suggested API:

```ts
export interface DeveloperIdleWatchdogOptions {
  idleTimeoutSeconds: number;
  stdoutPath: string;
  stderrPath: string;
  handoffPath: string;
  abortController: AbortController;
  now?: () => number;
  statFile?: (path: string) => { mtimeMs: number; size: number } | null;
}

export interface DeveloperIdleWatchdogResult {
  tripped: boolean;
  reason: string | null;
}

export function startDeveloperIdleWatchdog(options: DeveloperIdleWatchdogOptions): {
  stop(): DeveloperIdleWatchdogResult;
};
```

Implementation notes:

- Poll every `min(5000, idleTimeoutSeconds * 1000)` but not below 250ms for test overrides.
- Track activity from stdout/stderr file size or mtime and handoff file mtime/size.
- If no activity occurs for the idle timeout, call `abortController.abort()`.
- `stop()` clears timers and reports whether it tripped.

### 3. Task Graph Integration

File:

- `src/orchestrator/task-graph-loop.ts`

Changes:

- Before task loop, call `preflightTaskGraphScopes(taskGraph)` and append warnings to `iteration-log.md`.
- In `runTaskGraphTaskSerial`, create a local `AbortController` per Developer attempt.
- Combine it with the existing `combinedSignal` using a helper. If existing signal aborts, local signal should also abort; if watchdog aborts, `runAgent` sees cancellation.
- Start watchdog immediately before `runAgent` and stop it in `finally`.
- If watchdog tripped and `developerResult.status === 'cancelled'`, treat it as a task failure with `AGENT_TIMEOUT` details. Exhaustion should lead to the existing task BLOCKED path.
- Append a `developer idle watchdog` FAIL log with task id and attempt.

### 4. Prompt Guidance

Files:

- `src/agents/prompt-builder.ts`
- possibly `prompts/developer.md` only if task prompts reuse that template
- tests under `tests/unit/`

Find `buildTaskDeveloperPrompt` and add the scope-expansion protocol to task prompts. Add a unit test that builds a task prompt and asserts the text contains:

- `scope_expansion_request`
- `status: "BLOCKED"`
- `outside allowed_changes`

### 5. Tests

Targeted tests:

- `tests/unit/config.test.ts`
- `tests/unit/task-graph-preflight.test.ts`
- `tests/unit/developer-idle-watchdog.test.ts`
- task prompt builder unit test, wherever existing prompt-builder tests live
- `tests/integration/run-orchestrator.test.ts` or a task-graph-specific integration test for a hanging Developer

Fake agent behavior:

- Add `hang-silent` or reuse existing timeout behavior if it produces no output.
- Integration config should set `runtime.agent_idle_timeout_seconds: 1` and Developer timeout high enough that the idle watchdog fires first.

Expected integration result:

- terminal phase `BLOCKED`
- detail/error mentions idle timeout/stall
- run completes quickly, not after the full Developer timeout

## Verification

Run:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

Also run targeted tests during implementation:

```bash
npm test -- --run tests/unit/config.test.ts
npm test -- --run tests/unit/task-graph-preflight.test.ts
npm test -- --run tests/unit/developer-idle-watchdog.test.ts
npm test -- --run tests/integration/run-orchestrator.test.ts -t "idle watchdog|scope preflight"
```

## Acceptance

- Silent task-graph Developer stalls convert into `BLOCKED` with actionable idle-timeout details.
- Scope preflight warning is logged for integration-test tasks with tests-only allowed changes.
- Developer prompt tells agents to request scope expansion via BLOCKED handoff instead of editing out-of-scope files.
- Full engineering gates pass.
- No provider/model escalation is implemented.
