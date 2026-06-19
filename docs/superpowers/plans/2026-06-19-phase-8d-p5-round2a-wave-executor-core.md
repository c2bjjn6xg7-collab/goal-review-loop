# Phase 8D P5 Round 2A Wave Executor Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure, side-effect-free wave executor core that schedules `TaskNode` work by waves, conflict demotion, and `maxParallelWorkers`, without touching the real orchestrator task loop yet.

**Architecture:** Round 1 already added `computeWaves`, `demoteConflicts`, and `validateWaveDependencies` in `src/scheduler/wave-compute.ts`. Round 2A adds a scheduler-only executor in `src/scheduler/wave-executor.ts` that accepts a `runTask` callback and returns deterministic results/events. Real worktree execution, CLI flags, `run-orchestrator.ts` dispatch, `task-graph-loop.ts` extraction, resume semantics, and task result handoff remain owned by Round 2B/P6/P7/P8.

**Tech Stack:** TypeScript, Vitest, existing `TaskNode`/`TaskStatus` types, `detectWaveConflicts`, `computeWaves`, `demoteConflicts`, `validateWaveDependencies`.

---

## Scope

Round 2A is intentionally small. It proves the wave scheduling engine before wiring it into the expensive agent/worktree path.

**In scope**
- Create `src/scheduler/wave-executor.ts`.
- Add unit tests in `tests/unit/wave-executor.test.ts`.
- Use existing Round 1 functions:
  - `computeWaves(tasks)`
  - `detectWaveConflicts(tasks, trackedFiles)`
  - `demoteConflicts(plan, conflicts, tasks)`
  - `validateWaveDependencies(plan, tasks)`
- Enforce `maxParallelWorkers` batching inside a wave.
- Preserve deterministic task order and event order.
- Convert `runTask` thrown errors into a failed task result.

**Out of scope for this run**
- Do not modify `src/orchestrator/run-orchestrator.ts`.
- Do not modify `src/orchestrator/task-graph-loop.ts`.
- Do not modify `src/cli/start.ts`.
- Do not create worktrees or run real Developer/Auditor agents.
- Do not change prompts.
- Do not add resume behavior.
- Do not add result files under `.agent/task-runs`.
- Do not change `current_task_index`.

This split prevents Round 2A from accidentally swallowing P6/P7/P8.

---

## File Structure

- Create: `src/scheduler/wave-executor.ts`
  - Owns the pure scheduler core.
  - Imports `TaskNode`/`TaskStatus` types.
  - Imports wave computation and conflict detection.
  - Does not import orchestrator, git, filesystem, agent, or state-store modules.
- Create: `tests/unit/wave-executor.test.ts`
  - Unit tests for concurrency limit, wave gates, conflict demotion, non-parallelizable waves, thrown worker errors, and dependency validation.
- Do not modify: `src/orchestrator/run-orchestrator.ts`
- Do not modify: `src/orchestrator/task-graph-loop.ts`
- Do not modify: `src/cli/start.ts`

---

## Public API Contract

Implement this API in `src/scheduler/wave-executor.ts`:

```ts
import type { TaskNode, TaskStatus } from '../types.js';
import type { WavePlan } from './wave-compute.js';

export type WaveTerminalTaskStatus =
  | typeof TaskStatus.PASSED
  | typeof TaskStatus.FAILED
  | typeof TaskStatus.BLOCKED;

export interface WaveTaskRunnerContext {
  waveIndex: number;
  batchIndex: number;
  taskIndexInBatch: number;
  maxParallelWorkers: number;
}

export interface WaveTaskRunnerResult {
  taskId: string;
  status: WaveTerminalTaskStatus;
  error: string | null;
}

export type WaveTaskRunner = (
  task: TaskNode,
  context: WaveTaskRunnerContext,
) => Promise<WaveTaskRunnerResult>;

export type WaveExecutorEvent =
  | { type: 'plan-computed'; plan: string[][] }
  | { type: 'wave-start'; waveIndex: number; taskIds: string[] }
  | { type: 'batch-start'; waveIndex: number; batchIndex: number; taskIds: string[] }
  | { type: 'task-start'; waveIndex: number; batchIndex: number; taskId: string }
  | { type: 'task-finish'; waveIndex: number; batchIndex: number; taskId: string; status: WaveTerminalTaskStatus; error: string | null }
  | { type: 'batch-finish'; waveIndex: number; batchIndex: number; taskIds: string[] }
  | { type: 'wave-finish'; waveIndex: number; taskIds: string[] };

export interface RunWaveExecutorParams {
  tasks: TaskNode[];
  trackedFiles: string[];
  maxParallelWorkers: number;
  runTask: WaveTaskRunner;
  onEvent?: (event: WaveExecutorEvent) => void;
}

export interface WaveExecutorResult {
  plan: WavePlan;
  results: WaveTaskRunnerResult[];
  events: WaveExecutorEvent[];
}

export class WaveExecutorError extends Error {
  public readonly code: 'invalid-worker-count' | 'invalid-runner-result';
}

export async function runWaveExecutorCore(
  params: RunWaveExecutorParams,
): Promise<WaveExecutorResult>;
```

Implementation notes:
- `maxParallelWorkers` must be an integer `>= 1`; otherwise throw `WaveExecutorError` with code `invalid-worker-count`.
- Build the plan in this exact order:
  1. `computeWaves(tasks)`
  2. `detectWaveConflicts(tasks, trackedFiles)`
  3. `demoteConflicts(plan, conflicts, tasks)`
  4. `validateWaveDependencies(plan, tasks)`
- Emit `plan-computed` after the final validated plan exists.
- Execute waves sequentially.
- Inside each wave, split task ids into batches of size `maxParallelWorkers`.
- Execute each batch with `Promise.all`.
- Do not start wave `N + 1` until every batch in wave `N` has finished.
- If `runTask` throws, record a result for that task with status `failed` and the thrown message.
- If `runTask` returns a `taskId` different from the task being executed, throw `WaveExecutorError` with code `invalid-runner-result`.
- Return results in actual finish order. Tests should not require finish order for parallel tasks unless the test controls promise resolution.
- Record every emitted event in `events` and also call `onEvent` if provided.

---

## Task 1: Add Failing Unit Tests

**Files:**
- Create: `tests/unit/wave-executor.test.ts`

- [ ] **Step 1: Create the test file with a reusable task helper**

Use this helper exactly so every `TaskNode` field is present:

```ts
import { describe, expect, it } from 'vitest';
import { TaskStatus, type TaskNode } from '../../src/types.js';
import {
  WaveExecutorError,
  runWaveExecutorCore,
  type WaveExecutorEvent,
} from '../../src/scheduler/wave-executor.js';

function makeTask(
  id: string,
  opts: {
    dependsOn?: string[];
    parallelizable?: boolean;
    allowedChanges?: string[];
  } = {},
): TaskNode {
  return {
    id,
    title: id,
    description: `Task ${id}`,
    difficulty: 'low',
    risk: 'low',
    parallelizable: opts.parallelizable ?? true,
    depends_on: opts.dependsOn ?? [],
    allowed_changes: opts.allowedChanges ?? [`src/${id}/**`],
    disallowed_changes: [],
    verification_commands: [],
    status: TaskStatus.PENDING,
  };
}
```

- [ ] **Step 2: Test same-wave tasks obey `maxParallelWorkers`**

Add this test:

```ts
it('runs independent same-wave tasks in batches capped by maxParallelWorkers', async () => {
  const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
  let active = 0;
  let maxActive = 0;

  const result = await runWaveExecutorCore({
    tasks,
    trackedFiles: ['src/a/file.ts', 'src/b/file.ts', 'src/c/file.ts'],
    maxParallelWorkers: 2,
    runTask: async (task) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { taskId: task.id, status: TaskStatus.PASSED, error: null };
    },
  });

  expect(result.plan.waves).toEqual([['a', 'b', 'c']]);
  expect(maxActive).toBe(2);
  expect(result.results.map((r) => r.taskId).sort()).toEqual(['a', 'b', 'c']);
});
```

- [ ] **Step 3: Test wave gate order**

Add this test:

```ts
it('does not start a dependent wave before the prior wave finishes', async () => {
  const tasks = [makeTask('a'), makeTask('b', { dependsOn: ['a'] })];
  const events: string[] = [];

  await runWaveExecutorCore({
    tasks,
    trackedFiles: ['src/a/file.ts', 'src/b/file.ts'],
    maxParallelWorkers: 2,
    runTask: async (task) => {
      events.push(`start:${task.id}`);
      await new Promise((resolve) => setTimeout(resolve, task.id === 'a' ? 20 : 1));
      events.push(`finish:${task.id}`);
      return { taskId: task.id, status: TaskStatus.PASSED, error: null };
    },
  });

  expect(events).toEqual(['start:a', 'finish:a', 'start:b', 'finish:b']);
});
```

- [ ] **Step 4: Test conflict demotion uses tracked files and dependency validation**

Add these tests:

```ts
it('demotes conflicting tasks into separate waves before execution', async () => {
  const tasks = [
    makeTask('a', { allowedChanges: ['src/shared/**'] }),
    makeTask('b', { allowedChanges: ['src/shared/file.ts'] }),
  ];
  const started: string[] = [];

  const result = await runWaveExecutorCore({
    tasks,
    trackedFiles: ['src/shared/file.ts'],
    maxParallelWorkers: 2,
    runTask: async (task) => {
      started.push(task.id);
      return { taskId: task.id, status: TaskStatus.PASSED, error: null };
    },
  });

  expect(result.plan.waves).toEqual([['a'], ['b']]);
  expect(started).toEqual(['a', 'b']);
});

it('throws when conflict demotion would violate dependency ordering', async () => {
  const tasks = [
    makeTask('a', { allowedChanges: ['src/shared/**'] }),
    makeTask('b', { allowedChanges: ['src/shared/file.ts'] }),
    makeTask('c', { dependsOn: ['b'], allowedChanges: ['src/c/**'] }),
  ];

  await expect(
    runWaveExecutorCore({
      tasks,
      trackedFiles: ['src/shared/file.ts', 'src/c/file.ts'],
      maxParallelWorkers: 2,
      runTask: async (task) => ({ taskId: task.id, status: TaskStatus.PASSED, error: null }),
    }),
  ).rejects.toThrow(/dependency wave|not before task wave/i);
});
```

- [ ] **Step 5: Test non-parallelizable task isolation**

Add this test:

```ts
it('keeps non-parallelizable tasks in singleton waves', async () => {
  const tasks = [
    makeTask('a', { parallelizable: false }),
    makeTask('b'),
    makeTask('c'),
  ];

  const result = await runWaveExecutorCore({
    tasks,
    trackedFiles: ['src/a/file.ts', 'src/b/file.ts', 'src/c/file.ts'],
    maxParallelWorkers: 3,
    runTask: async (task) => ({ taskId: task.id, status: TaskStatus.PASSED, error: null }),
  });

  expect(result.plan.waves).toEqual([['a'], ['b', 'c']]);
});
```

- [ ] **Step 6: Test thrown runner errors and invalid options**

Add these tests:

```ts
it('records a failed result when runTask throws', async () => {
  const result = await runWaveExecutorCore({
    tasks: [makeTask('a')],
    trackedFiles: ['src/a/file.ts'],
    maxParallelWorkers: 1,
    runTask: async () => {
      throw new Error('boom');
    },
  });

  expect(result.results).toEqual([
    { taskId: 'a', status: TaskStatus.FAILED, error: 'boom' },
  ]);
});

it('rejects invalid maxParallelWorkers', async () => {
  await expect(
    runWaveExecutorCore({
      tasks: [makeTask('a')],
      trackedFiles: ['src/a/file.ts'],
      maxParallelWorkers: 0,
      runTask: async (task) => ({ taskId: task.id, status: TaskStatus.PASSED, error: null }),
    }),
  ).rejects.toMatchObject({
    code: 'invalid-worker-count',
  } satisfies Partial<WaveExecutorError>);
});

it('rejects a runner result for the wrong task id', async () => {
  await expect(
    runWaveExecutorCore({
      tasks: [makeTask('a')],
      trackedFiles: ['src/a/file.ts'],
      maxParallelWorkers: 1,
      runTask: async () => ({ taskId: 'wrong', status: TaskStatus.PASSED, error: null }),
    }),
  ).rejects.toMatchObject({
    code: 'invalid-runner-result',
  } satisfies Partial<WaveExecutorError>);
});
```

- [ ] **Step 7: Run the new test and confirm it fails before implementation**

Run:

```bash
npm test -- tests/unit/wave-executor.test.ts
```

Expected:
- Fails because `src/scheduler/wave-executor.ts` does not exist.

---

## Task 2: Implement the Wave Executor Core

**Files:**
- Create: `src/scheduler/wave-executor.ts`
- Test: `tests/unit/wave-executor.test.ts`

- [ ] **Step 1: Create `src/scheduler/wave-executor.ts` with imports and exported types**

Start with:

```ts
import { TaskStatus, type TaskNode } from '../types.js';
import { detectWaveConflicts } from './conflict-detector.js';
import {
  computeWaves,
  demoteConflicts,
  validateWaveDependencies,
  type WavePlan,
} from './wave-compute.js';
```

Define the exported types exactly as listed in the Public API Contract.

- [ ] **Step 2: Implement `WaveExecutorError`**

Use this class shape:

```ts
export class WaveExecutorError extends Error {
  public readonly code: 'invalid-worker-count' | 'invalid-runner-result';

  constructor(
    message: string,
    code: 'invalid-worker-count' | 'invalid-runner-result',
  ) {
    super(message);
    this.name = 'WaveExecutorError';
    this.code = code;
  }
}
```

- [ ] **Step 3: Implement event recording helper**

Inside `runWaveExecutorCore`, create:

```ts
const events: WaveExecutorEvent[] = [];
const emit = (event: WaveExecutorEvent): void => {
  events.push(event);
  params.onEvent?.(event);
};
```

- [ ] **Step 4: Implement plan computation**

Use this exact sequence:

```ts
let plan = computeWaves(params.tasks);
const conflicts = detectWaveConflicts(params.tasks, params.trackedFiles);
plan = demoteConflicts(plan, conflicts, params.tasks);
validateWaveDependencies(plan, params.tasks);
emit({ type: 'plan-computed', plan: plan.waves.map((wave) => [...wave]) });
```

Do not call `demoteConflicts(plan, conflicts)` without the third `tasks` argument; that would reintroduce the Round 1 risk_note bug.

- [ ] **Step 5: Implement wave and batch execution**

Use this structure:

```ts
const byId = new Map(params.tasks.map((task) => [task.id, task]));
const results: WaveTaskRunnerResult[] = [];

for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex++) {
  const wave = plan.waves[waveIndex];
  emit({ type: 'wave-start', waveIndex, taskIds: [...wave] });

  for (let batchStart = 0, batchIndex = 0; batchStart < wave.length; batchStart += params.maxParallelWorkers, batchIndex++) {
    const batch = wave.slice(batchStart, batchStart + params.maxParallelWorkers);
    emit({ type: 'batch-start', waveIndex, batchIndex, taskIds: [...batch] });

    const batchResults = await Promise.all(batch.map(async (taskId, taskIndexInBatch) => {
      const task = byId.get(taskId);
      if (!task) {
        throw new WaveExecutorError(`Wave plan referenced unknown task "${taskId}"`, 'invalid-runner-result');
      }
      emit({ type: 'task-start', waveIndex, batchIndex, taskId });
      const result = await runOneTaskSafely(task, {
        waveIndex,
        batchIndex,
        taskIndexInBatch,
        maxParallelWorkers: params.maxParallelWorkers,
      });
      emit({ type: 'task-finish', waveIndex, batchIndex, taskId, status: result.status, error: result.error });
      return result;
    }));

    results.push(...batchResults);
    emit({ type: 'batch-finish', waveIndex, batchIndex, taskIds: [...batch] });
  }

  emit({ type: 'wave-finish', waveIndex, taskIds: [...wave] });
}
```

Implement `runOneTaskSafely` inside `runWaveExecutorCore` or as a private helper. It must:
- call `params.runTask(task, context)`;
- verify `result.taskId === task.id`;
- convert thrown errors to `{ taskId: task.id, status: TaskStatus.FAILED, error: message }`.

- [ ] **Step 6: Validate worker count before planning**

At the start of `runWaveExecutorCore`:

```ts
if (!Number.isInteger(params.maxParallelWorkers) || params.maxParallelWorkers < 1) {
  throw new WaveExecutorError(
    `maxParallelWorkers must be a positive integer, got ${params.maxParallelWorkers}`,
    'invalid-worker-count',
  );
}
```

- [ ] **Step 7: Run the targeted test**

Run:

```bash
npm test -- tests/unit/wave-executor.test.ts
```

Expected:
- All tests in `tests/unit/wave-executor.test.ts` pass.

---

## Task 3: Verify No Orchestrator Wiring Slipped In

**Files:**
- Inspect only:
  - `src/orchestrator/run-orchestrator.ts`
  - `src/orchestrator/task-graph-loop.ts`
  - `src/cli/start.ts`

- [ ] **Step 1: Confirm no out-of-scope files changed**

Run:

```bash
git diff --name-only
```

Expected changed files:

```text
src/scheduler/wave-executor.ts
tests/unit/wave-executor.test.ts
```

If documentation generated by the review loop changes under `.agent/`, that is acceptable. Source changes outside the two files above are not part of Round 2A.

- [ ] **Step 2: Confirm the executor is pure**

Run:

```bash
rg -n "fs|node:fs|child_process|execSync|runAgent|StateStore|ArtifactStore|runOrchestrator|runTaskGraphLoop|WorktreeManager" src/scheduler/wave-executor.ts
```

Expected:
- No matches.

---

## Task 4: Run Engineering Gates

**Files:**
- All changed files.

- [ ] **Step 1: Typecheck**

Run:

```bash
npm run typecheck
```

Expected:
- Exit code 0.

- [ ] **Step 2: Lint**

Run:

```bash
npm run lint
```

Expected:
- Exit code 0 and zero warnings.

- [ ] **Step 3: Build**

Run:

```bash
npm run build
```

Expected:
- Exit code 0.

- [ ] **Step 4: Test**

Run:

```bash
npm test
```

Expected:
- Exit code 0.
- Existing 923 tests remain green.
- New wave executor tests increase the total test count.

- [ ] **Step 5: Whitespace check**

Run:

```bash
git diff --check
```

Expected:
- Exit code 0.

---

## Review-Loop Start Request

Use this as the request text for the automated implementation run:

```text
Implement Phase 8D P5 Round 2A only: pure wave executor core.

Read and follow docs/superpowers/plans/2026-06-19-phase-8d-p5-round2a-wave-executor-core.md.

Hard scope:
- Create src/scheduler/wave-executor.ts.
- Create tests/unit/wave-executor.test.ts.
- Do not modify src/orchestrator/run-orchestrator.ts.
- Do not modify src/orchestrator/task-graph-loop.ts.
- Do not modify src/cli/start.ts.
- Do not create worktrees.
- Do not run real Developer/Auditor agents.
- Do not change prompts.
- Do not add resume behavior or .agent/task-runs.

Acceptance:
- runWaveExecutorCore computes plan via computeWaves -> detectWaveConflicts -> demoteConflicts(plan, conflicts, tasks) -> validateWaveDependencies.
- maxParallelWorkers batches tasks inside each wave.
- Waves are gated: next wave starts only after all batches in current wave finish.
- runTask thrown errors become failed task results.
- Wrong taskId from runTask throws WaveExecutorError invalid-runner-result.
- Invalid maxParallelWorkers throws WaveExecutorError invalid-worker-count.
- Unit tests cover concurrency cap, wave gate, conflict demotion, dependency validation, non-parallelizable singleton waves, thrown worker errors, and invalid worker count.
- Engineering gates pass: npm run typecheck, npm run lint, npm run build, npm test, git diff --check.
```

---

## Self-Review

- Spec coverage: Round 2A covers the scheduler core needed before real worktree orchestration. Orchestrator wiring is explicitly out of scope to avoid mixing P5 with P6/P7/P8.
- Placeholder scan: No placeholder tasks remain; every code-changing task contains concrete API or test content.
- Type consistency: The public API uses existing `TaskNode`, `TaskStatus`, and `WavePlan` names from the current codebase.
- Risk control: The plan requires the third `tasks` argument to `demoteConflicts` so the Round 1 dependency-order regression stays protected.
