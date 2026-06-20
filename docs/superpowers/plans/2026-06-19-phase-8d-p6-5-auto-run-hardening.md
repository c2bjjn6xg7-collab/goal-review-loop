# Phase 8D P6.5 Auto-run Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plugin-driven task-graph runs fail fast and clearly when Developer stalls or task scope is likely insufficient.

**Architecture:** Add a runtime idle watchdog around task-graph Developer attempts, a pure task-graph scope preflight helper, and prompt guidance for explicit scope-expansion BLOCKED handoffs. Keep provider/model routing unchanged and do not add automatic scope widening.

**Tech Stack:** TypeScript, Node.js timers/filesystem, Vitest, existing review-loop task graph/orchestrator modules.

---

## Files

- Modify: `src/types.ts` — add `runtime.agent_idle_timeout_seconds` to config type.
- Modify: `src/artifacts/config.ts` — schema/default/backfill for the new runtime setting.
- Modify: `docs/configuration.md` — document the new runtime setting.
- Create: `src/orchestrator/developer-idle-watchdog.ts` — focused watchdog helper.
- Create: `tests/unit/developer-idle-watchdog.test.ts` — watchdog unit tests with fake timers.
- Create: `src/orchestrator/task-graph-preflight.ts` — pure scope preflight helper.
- Create: `tests/unit/task-graph-preflight.test.ts` — preflight unit tests.
- Modify: `src/orchestrator/task-graph-loop.ts` — call preflight, wire watchdog around Developer attempts.
- Modify: `src/agents/prompt-builder.ts` — add scope-expansion protocol to task Developer prompt.
- Modify: `tests/unit/task-prompt-builder.test.ts` — assert protocol text.
- Modify: `tests/fixtures/fake-agent.mjs` — add silent hang Developer behavior if needed.
- Modify: `tests/integration/task-graph.test.ts` — add integration coverage for watchdog/preflight.

---

### Task 1: Runtime Config for Idle Watchdog

**Files:**
- Modify: `src/types.ts`
- Modify: `src/artifacts/config.ts`
- Modify: `tests/unit/config.test.ts`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Add failing config expectations**

In `tests/unit/config.test.ts`, add/adjust assertions near existing runtime/default config tests:

```ts
expect(DEFAULT_CONFIG.runtime.agent_idle_timeout_seconds).toBe(480);
```

In the omitted-runtime backfill test, add:

```ts
expect(config.runtime.agent_idle_timeout_seconds).toBe(480);
```

Add explicit validation tests near other runtime validation cases:

```ts
it('accepts explicit agent idle timeout override', async () => {
  const configPath = join(tempDir, 'review-loop.yaml');
  writeFileSync(configPath, `
version: 1
agents:
  planner: { command: ['echo', 'planner'], timeout_seconds: 60 }
  developer: { command: ['echo', 'developer'], timeout_seconds: 60 }
  auditor: { command: ['echo', 'auditor'], timeout_seconds: 60 }
  final_auditor: { command: ['echo', 'final'], timeout_seconds: 60 }
loop: { max_iterations: 3, archive_history: true, stop_on_infrastructure_error: true, max_consecutive_failures: 3, max_agent_retries: 3 }
git: { require_repository: true, require_head: true, require_clean_worktree: true, branch_template: 'agent/{run_id}-{task_slug}', commit_on_pass: true, commit_template: 'feat: {task_slug}', create_tag: false, tag_template: 'agent-{run_id}', push: false }
runtime: { kill_grace_seconds: 10, max_log_bytes: 1048576, lock_stale_seconds: 86400, cancel_grace_seconds: 10, agent_idle_timeout_seconds: 2 }
`, 'utf8');

  const config = await loadConfig(configPath);
  expect(config.runtime.agent_idle_timeout_seconds).toBe(2);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm test -- --run tests/unit/config.test.ts
```

Expected: FAIL because `agent_idle_timeout_seconds` is not defined in defaults/schema/type.

- [ ] **Step 3: Implement config field**

In `src/types.ts`, update `RuntimeConfig`:

```ts
export interface RuntimeConfig {
  kill_grace_seconds: number;
  max_log_bytes: number;
  lock_stale_seconds: number;
  cancel_grace_seconds?: number;
  /** Phase 8D P6.5: Developer no-output idle watchdog. Default: 480s. */
  agent_idle_timeout_seconds: number;
}
```

In `src/artifacts/config.ts`, add schema property:

```ts
agent_idle_timeout_seconds: { type: 'number', minimum: 1 },
```

Add default:

```ts
runtime: {
  kill_grace_seconds: 10,
  max_log_bytes: 10485760,
  lock_stale_seconds: 86400,
  cancel_grace_seconds: 10,
  agent_idle_timeout_seconds: 480,
},
```

Add backfill near existing runtime backfills:

```ts
if (config.runtime.agent_idle_timeout_seconds === undefined) {
  config.runtime.agent_idle_timeout_seconds = DEFAULT_CONFIG.runtime.agent_idle_timeout_seconds;
}
```

In `docs/configuration.md`, add under `runtime:`:

```yaml
  agent_idle_timeout_seconds: 480  # abort Developer if no stdout/stderr/handoff activity for 8 minutes
```

- [ ] **Step 4: Verify config tests pass**

Run:

```bash
npm test -- --run tests/unit/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/artifacts/config.ts tests/unit/config.test.ts docs/configuration.md
git commit -m "feat(phase-8d/p6.5): add agent idle timeout config"
```

---

### Task 2: Developer Idle Watchdog Helper

**Files:**
- Create: `src/orchestrator/developer-idle-watchdog.ts`
- Create: `tests/unit/developer-idle-watchdog.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `tests/unit/developer-idle-watchdog.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDeveloperIdleWatchdog } from '../../src/orchestrator/developer-idle-watchdog.js';

describe('startDeveloperIdleWatchdog', () => {
  afterEach(() => vi.useRealTimers());

  it('aborts after the idle timeout with no file activity', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const watcher = startDeveloperIdleWatchdog({
      idleTimeoutSeconds: 1,
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
      handoffPath: '/tmp/handoff.md',
      abortController: controller,
      now: () => Date.now(),
      statFile: () => null,
    });

    vi.advanceTimersByTime(1250);
    const result = watcher.stop();

    expect(controller.signal.aborted).toBe(true);
    expect(result.tripped).toBe(true);
    expect(result.reason).toContain('1s');
  });

  it('does not abort when file activity advances', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let size = 0;
    const watcher = startDeveloperIdleWatchdog({
      idleTimeoutSeconds: 1,
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
      handoffPath: '/tmp/handoff.md',
      abortController: controller,
      now: () => Date.now(),
      statFile: () => ({ mtimeMs: Date.now(), size }),
    });

    vi.advanceTimersByTime(500);
    size += 10;
    vi.advanceTimersByTime(500);
    const result = watcher.stop();

    expect(controller.signal.aborted).toBe(false);
    expect(result.tripped).toBe(false);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

```bash
npm test -- --run tests/unit/developer-idle-watchdog.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement watchdog helper**

Create `src/orchestrator/developer-idle-watchdog.ts`:

```ts
import { statSync } from 'node:fs';

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

interface FileActivity {
  mtimeMs: number;
  size: number;
}

function defaultStatFile(path: string): FileActivity | null {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function activitySignature(files: Array<FileActivity | null>): string {
  return files.map((file) => file ? `${file.mtimeMs}:${file.size}` : 'missing').join('|');
}

export function startDeveloperIdleWatchdog(options: DeveloperIdleWatchdogOptions): { stop(): DeveloperIdleWatchdogResult } {
  const now = options.now ?? (() => Date.now());
  const statFile = options.statFile ?? defaultStatFile;
  const idleTimeoutMs = options.idleTimeoutSeconds * 1000;
  const pollMs = Math.max(250, Math.min(5000, idleTimeoutMs));
  let lastActivityAt = now();
  let tripped = false;
  let reason: string | null = null;

  let lastSignature = activitySignature([
    statFile(options.stdoutPath),
    statFile(options.stderrPath),
    statFile(options.handoffPath),
  ]);

  const timer = setInterval(() => {
    const currentSignature = activitySignature([
      statFile(options.stdoutPath),
      statFile(options.stderrPath),
      statFile(options.handoffPath),
    ]);
    const currentTime = now();

    if (currentSignature !== lastSignature) {
      lastSignature = currentSignature;
      lastActivityAt = currentTime;
      return;
    }

    if (!options.abortController.signal.aborted && currentTime - lastActivityAt >= idleTimeoutMs) {
      tripped = true;
      reason = `Developer idle watchdog tripped after ${options.idleTimeoutSeconds}s with no stdout/stderr/handoff activity`;
      options.abortController.abort();
    }
  }, pollMs);

  return {
    stop(): DeveloperIdleWatchdogResult {
      clearInterval(timer);
      return { tripped, reason };
    },
  };
}
```

- [ ] **Step 4: Verify helper tests pass**

```bash
npm test -- --run tests/unit/developer-idle-watchdog.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/developer-idle-watchdog.ts tests/unit/developer-idle-watchdog.test.ts
git commit -m "feat(phase-8d/p6.5): add developer idle watchdog"
```

---

### Task 3: Task Graph Scope Preflight

**Files:**
- Create: `src/orchestrator/task-graph-preflight.ts`
- Create: `tests/unit/task-graph-preflight.test.ts`
- Modify: `src/orchestrator/task-graph-loop.ts`

- [ ] **Step 1: Write failing unit tests**

Create `tests/unit/task-graph-preflight.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { preflightTaskGraphScopes } from '../../src/orchestrator/task-graph-preflight.js';
import type { TaskGraph } from '../../src/types.js';

function graph(allowedChanges: string[]): TaskGraph {
  return {
    schema_version: 1,
    run_id: 'run-1',
    goal_digest: 'sha256:test',
    tasks: [{
      id: 'integration-only-tests',
      title: 'Add integration coverage',
      description: 'Add integration tests for orchestrator behavior',
      difficulty: 'medium',
      risk: 'medium',
      parallelizable: false,
      depends_on: [],
      allowed_changes: allowedChanges,
      disallowed_changes: [],
      verification_commands: [{ id: 'integration', command: ['npm', 'test', '--', '--run', 'tests/integration/run-orchestrator.test.ts'], cwd: '.', required: true, timeout_seconds: 900 }],
      status: 'pending',
    }],
  };
}

describe('preflightTaskGraphScopes', () => {
  it('warns when integration tests are paired with tests-only allowed changes', () => {
    const warnings = preflightTaskGraphScopes(graph(['tests/fixtures/fake-agent.mjs', 'tests/integration/run-orchestrator.test.ts']));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].task_id).toBe('integration-only-tests');
    expect(warnings[0].code).toBe('integration_tests_with_tests_only_scope');
  });

  it('does not warn when source files are allowed', () => {
    const warnings = preflightTaskGraphScopes(graph(['src/orchestrator/run-orchestrator.ts', 'tests/integration/run-orchestrator.test.ts']));
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

```bash
npm test -- --run tests/unit/task-graph-preflight.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement preflight helper**

Create `src/orchestrator/task-graph-preflight.ts`:

```ts
import type { TaskGraph, TaskNode } from '../types.js';

export interface TaskGraphPreflightWarning {
  task_id: string;
  code: 'integration_tests_with_tests_only_scope';
  message: string;
}

function isIntegrationVerification(task: TaskNode): boolean {
  return task.verification_commands
    .filter((command) => command.required)
    .some((command) => command.command.some((part) => part.includes('tests/integration')));
}

function isTestsOnlyPattern(pattern: string): boolean {
  return pattern === 'tests/**' || pattern.startsWith('tests/');
}

function hasSourceLikeAllowedChange(task: TaskNode): boolean {
  return task.allowed_changes.some((pattern) => {
    return pattern.startsWith('src/')
      || pattern.startsWith('prompts/')
      || pattern.startsWith('docs/')
      || pattern === 'review-loop.yaml'
      || pattern === 'package.json'
      || pattern.endsWith('config.ts')
      || pattern.endsWith('config.js')
      || pattern.endsWith('config.yaml')
      || pattern.endsWith('config.yml');
  });
}

export function preflightTaskGraphScopes(taskGraph: TaskGraph): TaskGraphPreflightWarning[] {
  return taskGraph.tasks.flatMap((task) => {
    if (!isIntegrationVerification(task)) return [];
    if (hasSourceLikeAllowedChange(task)) return [];
    if (!task.allowed_changes.every(isTestsOnlyPattern)) return [];
    return [{
      task_id: task.id,
      code: 'integration_tests_with_tests_only_scope' as const,
      message: `Task "${task.id}" runs integration tests but only allows tests/** changes; it may need source files in allowed_changes or a smaller test-only scope.`,
    }];
  });
}
```

- [ ] **Step 4: Log warnings before task execution**

In `src/orchestrator/task-graph-loop.ts`, import:

```ts
import { preflightTaskGraphScopes } from './task-graph-preflight.js';
```

In `runTaskGraphLoop`, after `const ordered = orderedTasks(taskGraph);` and before the task loop starts:

```ts
const preflightWarnings = preflightTaskGraphScopes(taskGraph);
for (const warning of preflightWarnings) {
  await appendLog(
    artifactStore,
    runId,
    0,
    'PLANNING',
    `task graph preflight ${warning.code}`,
    'FAIL',
    warning.message,
  );
}
```

- [ ] **Step 5: Verify preflight tests pass**

```bash
npm test -- --run tests/unit/task-graph-preflight.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/task-graph-preflight.ts tests/unit/task-graph-preflight.test.ts src/orchestrator/task-graph-loop.ts
git commit -m "feat(phase-8d/p6.5): warn on risky task scopes"
```

---

### Task 4: Wire Watchdog Into Task Graph Developer Attempts

**Files:**
- Modify: `src/orchestrator/task-graph-loop.ts`
- Modify: `tests/fixtures/fake-agent.mjs`
- Modify: `tests/integration/task-graph.test.ts`

- [ ] **Step 1: Add fake-agent silent hang behavior**

In `tests/fixtures/fake-agent.mjs`, add a Developer behavior:

```js
case 'hang-silent':
  // Intentionally write no handoff and no output. The idle watchdog should abort this before the full agent timeout.
  await new Promise((resolve) => setTimeout(resolve, 300000));
  break;
```

If the file uses role-specific switch blocks, add this under the Developer switch only.

- [ ] **Step 2: Write failing integration test**

In `tests/integration/task-graph.test.ts`, add a test that uses fake planner task graph and silent Developer. Use existing helpers in the file for repo/config setup. The config must set:

```yaml
runtime:
  kill_grace_seconds: 1
  max_log_bytes: 10485760
  lock_stale_seconds: 86400
  cancel_grace_seconds: 1
  agent_idle_timeout_seconds: 1
```

Test assertions:

```ts
const startedAt = Date.now();
const result = await runOrchestrator({ project_root: repoDir, request: 'Run task graph', task_slug: 'idle-watchdog' });
const durationMs = Date.now() - startedAt;

expect(result.phase).toBe('BLOCKED');
expect(result.exit_code).toBe(3);
expect(result.error?.code).toBe('VERIFICATION_FAILED');
expect(result.detail).toMatch(/idle watchdog|stalled|idle timeout/i);
expect(durationMs).toBeLessThan(15000);
const log = readFileSync(join(repoDir, '.agent', 'iteration-log.md'), 'utf8');
expect(log).toMatch(/developer idle watchdog|idle watchdog/i);
```

Use the existing task graph fake planner behavior if possible. If it creates multiple tasks, make the Developer behavior `hang-silent` so the first task stalls.

- [ ] **Step 3: Run test and verify it fails or times out without implementation**

```bash
npm test -- --run tests/integration/task-graph.test.ts -t "idle watchdog"
```

Expected: FAIL before implementation because the idle watchdog is not wired.

- [ ] **Step 4: Implement signal composition and watchdog wiring**

In `src/orchestrator/task-graph-loop.ts`, import:

```ts
import { startDeveloperIdleWatchdog } from './developer-idle-watchdog.js';
```

Add a small helper near the top of the file:

```ts
function createAttemptAbortController(parentSignal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parentSignal.aborted) {
    controller.abort();
    return controller;
  }
  parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}
```

In `runTaskGraphTaskSerial`, immediately before `runAgent(developerInput, projectRoot)`, create controller and watchdog:

```ts
const attemptAbortController = createAttemptAbortController(combinedSignal);
const developerInput = buildDeveloperInput({
  // existing fields
  signal: attemptAbortController.signal,
});
const watchdog = startDeveloperIdleWatchdog({
  idleTimeoutSeconds: config.runtime.agent_idle_timeout_seconds,
  stdoutPath: join(agentDir, 'debug', `${runId}-developer-iter${taskIndexDisplay}${attempt > 1 ? `-attempt${attempt}` : ''}.stdout.log`),
  stderrPath: join(agentDir, 'debug', `${runId}-developer-iter${taskIndexDisplay}${attempt > 1 ? `-attempt${attempt}` : ''}.stderr.log`),
  handoffPath,
  abortController: attemptAbortController,
});
try {
  developerResult = await runAgent(developerInput, projectRoot);
} finally {
  const watchdogResult = watchdog.stop();
  if (watchdogResult.tripped) {
    taskError = `Developer stalled on task ${task.id} attempt ${attempt} after ${config.runtime.agent_idle_timeout_seconds}s of no output`;
    await appendLog(artifactStore, runId, taskIndexDisplay, 'DEVELOPING', `task ${task.id} developer idle watchdog`, 'FAIL', taskError);
  }
}
```

Then after the `finally`, before generic cancelled handling, if watchdog tripped and `developerResult.status === 'cancelled'`, convert it into a task failure that will exhaust/retry normally:

```ts
if (watchdogResult.tripped) {
  taskError = `Developer stalled on task ${task.id} attempt ${attempt} after ${config.runtime.agent_idle_timeout_seconds}s of no output`;
  if (attempt < maxIterations) continue;
  break;
}
```

Keep exact variable placement consistent with TypeScript scoping; `watchdogResult` must be visible after the `try/finally`.

- [ ] **Step 5: Verify idle watchdog integration test passes**

```bash
npm test -- --run tests/integration/task-graph.test.ts -t "idle watchdog"
```

Expected: PASS in less than 15 seconds.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/task-graph-loop.ts tests/fixtures/fake-agent.mjs tests/integration/task-graph.test.ts
git commit -m "feat(phase-8d/p6.5): block stalled task developers"
```

---

### Task 5: Scope Expansion Prompt Protocol

**Files:**
- Modify: `src/agents/prompt-builder.ts`
- Modify: `tests/unit/task-prompt-builder.test.ts`

- [ ] **Step 1: Add failing prompt test**

In `tests/unit/task-prompt-builder.test.ts`, add:

```ts
it('instructs Developer to request scope expansion when needed', () => {
  const p = buildTaskDeveloperPrompt(baseCtx);
  expect(p).toContain('scope_expansion_request');
  expect(p).toContain('status: "BLOCKED"');
  expect(p).toMatch(/outside allowed_changes/i);
});
```

- [ ] **Step 2: Run test and verify it fails**

```bash
npm test -- --run tests/unit/task-prompt-builder.test.ts
```

Expected: FAIL because prompt text is missing.

- [ ] **Step 3: Add prompt protocol text**

In `src/agents/prompt-builder.ts`, inside `buildTaskDeveloperPrompt`, after the scope section and before verification, add:

```md
### If scope is insufficient

If you discover that this task requires changes outside allowed_changes, do not edit those files. Instead write developer-handoff.md with status: "BLOCKED" and add a "scope_expansion_request" section listing the needed paths and why they are required.
```

Keep this text inside the returned template string.

- [ ] **Step 4: Verify prompt tests pass**

```bash
npm test -- --run tests/unit/task-prompt-builder.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/prompt-builder.ts tests/unit/task-prompt-builder.test.ts
git commit -m "docs(phase-8d/p6.5): add scope expansion prompt protocol"
```

---

### Task 6: Final Verification and Scope Check

**Files:**
- No new source files unless a previous task requires a minimal fix.

- [ ] **Step 1: Run targeted tests**

```bash
npm test -- --run tests/unit/config.test.ts tests/unit/developer-idle-watchdog.test.ts tests/unit/task-graph-preflight.test.ts tests/unit/task-prompt-builder.test.ts
npm test -- --run tests/integration/task-graph.test.ts -t "idle watchdog|preflight"
```

Expected: all targeted tests PASS.

- [ ] **Step 2: Run full engineering gates**

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

Expected: all commands exit 0.

- [ ] **Step 3: Confirm forbidden features were not added**

Run:

```bash
rg -n "escalation_target|fallback provider|model switch|provider switch|auto.*scope widening|automatically widen" src tests
```

Expected: no new implementation that consumes `escalation_target`, switches provider/model, or automatically widens task scope.

- [ ] **Step 4: Confirm changed files are in scope**

Run:

```bash
git diff --name-only HEAD~5..HEAD
```

Expected changed files are limited to config, task graph/preflight/watchdog, prompt builder, tests, docs/configuration.

- [ ] **Step 5: Final commit if needed**

If any verification-only fixes were required:

```bash
git add <changed-files>
git commit -m "fix(phase-8d/p6.5): stabilize auto-run hardening"
```

Otherwise, do not create an empty commit.
