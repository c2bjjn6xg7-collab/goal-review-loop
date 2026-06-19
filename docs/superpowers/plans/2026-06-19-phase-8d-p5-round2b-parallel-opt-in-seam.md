# Phase 8D P5 Round 2B Parallel Opt-In Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit parallel-execution option resolution and CLI plumbing, with a fail-closed guard for true wave mode until the real worktree runner is wired.

**Architecture:** Round 1 added config storage; Round 2A added the pure wave executor core. Round 2B adds a small pure resolver that decides whether the current run is serial or wave-requested, threads CLI flags through `start` → `runOrchestrator`, and blocks explicit wave requests with a clear message instead of silently running serial. It does not run worktrees, does not call `runWaveExecutorCore` from the orchestrator, and does not change the default serial path.

**Tech Stack:** TypeScript, Commander, Vitest, existing `ReviewLoopConfig.parallel`, existing `runOrchestrator`, existing CLI `executeStart`.

---

## Scope

**In scope**
- Create `src/scheduler/parallel-execution.ts`.
- Add unit tests in `tests/unit/parallel-execution.test.ts`.
- Add CLI flags:
  - `--parallel`
  - `--max-parallel-workers <n>`
- Pass CLI overrides into `runOrchestrator`.
- In `runOrchestrator`, resolve the parallel decision once after config load.
- If the decision is real wave mode (`parallel requested` and `maxParallelWorkers > 1`), return `BLOCKED` with a clear `CONFIG_ERROR` message because worktree-backed execution is not wired until a later round.
- Preserve default behavior: no flags + default config still uses the existing serial path.

**Out of scope**
- Do not modify `src/orchestrator/task-graph-loop.ts`.
- Do not call `runWaveExecutorCore` from `runOrchestrator`.
- Do not create worktrees.
- Do not run parallel Developer/Auditor agents.
- Do not add resume behavior.
- Do not add `.agent/task-runs`.
- Do not change prompts.
- Do not remove or change `current_task_index`.

This round is a seam and safety guard. It intentionally prevents silent fake-parallel execution.

---

## File Structure

- Create: `src/scheduler/parallel-execution.ts`
  - Pure option/config resolver.
  - No filesystem, git, agent, orchestrator state, or process imports.
- Create: `tests/unit/parallel-execution.test.ts`
  - Unit coverage for default, config, CLI override, validation, and explicit opt-in semantics.
- Modify: `src/cli/start.ts`
  - Add flags and validation.
  - Pass overrides to `runOrchestrator`.
- Modify: `src/orchestrator/run-orchestrator.ts`
  - Add optional params.
  - Resolve decision after config load.
  - Fail closed for wave mode until real execution is wired.
- Modify: `tests/integration/no-commit-bypass.test.ts`
  - Extend existing Commander parsing test to cover new flags.

---

## Task 1: Add Pure Parallel Decision Resolver

**Files:**
- Create: `src/scheduler/parallel-execution.ts`
- Test: `tests/unit/parallel-execution.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Create `tests/unit/parallel-execution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/artifacts/config.js';
import {
  ParallelExecutionConfigError,
  resolveParallelExecution,
} from '../../src/scheduler/parallel-execution.js';
import type { ReviewLoopConfig } from '../../src/types.js';

function cfg(parallel: ReviewLoopConfig['parallel']): ReviewLoopConfig {
  return { ...DEFAULT_CONFIG, parallel };
}

describe('resolveParallelExecution', () => {
  it('defaults to serial with one worker when parallel config is absent', () => {
    const config = { ...DEFAULT_CONFIG, parallel: undefined };
    expect(resolveParallelExecution(config)).toEqual({
      enabled: false,
      mode: 'serial',
      maxParallelWorkers: 1,
      source: 'default',
      reason: 'parallel execution disabled',
    });
  });

  it('does not enable parallelism from max_parallel_workers alone', () => {
    expect(resolveParallelExecution(cfg({ enabled: false, max_parallel_workers: 4 }))).toEqual({
      enabled: false,
      mode: 'serial',
      maxParallelWorkers: 1,
      source: 'config',
      reason: 'parallel execution disabled',
    });
  });

  it('treats enabled true with one worker as explicit serial', () => {
    expect(resolveParallelExecution(cfg({ enabled: true, max_parallel_workers: 1 }))).toEqual({
      enabled: true,
      mode: 'serial',
      maxParallelWorkers: 1,
      source: 'config',
      reason: 'parallel requested but maxParallelWorkers is 1',
    });
  });

  it('selects wave mode from config only when enabled and workers exceed one', () => {
    expect(resolveParallelExecution(cfg({ enabled: true, max_parallel_workers: 3 }))).toEqual({
      enabled: true,
      mode: 'wave',
      maxParallelWorkers: 3,
      source: 'config',
      reason: 'parallel wave execution requested',
    });
  });

  it('selects wave mode when CLI --parallel uses the config worker count', () => {
    expect(resolveParallelExecution(
      cfg({ enabled: false, max_parallel_workers: 4 }),
      { parallel: true },
    )).toMatchObject({
      enabled: true,
      mode: 'wave',
      maxParallelWorkers: 4,
      source: 'cli',
    });
  });

  it('does not enable parallelism from CLI maxParallelWorkers alone', () => {
    expect(resolveParallelExecution(
      cfg({ enabled: false, max_parallel_workers: 1 }),
      { maxParallelWorkers: 5 },
    )).toEqual({
      enabled: false,
      mode: 'serial',
      maxParallelWorkers: 1,
      source: 'cli',
      reason: 'parallel execution disabled',
    });
  });

  it('lets CLI maxParallelWorkers override config when parallel is enabled', () => {
    expect(resolveParallelExecution(
      cfg({ enabled: true, max_parallel_workers: 2 }),
      { maxParallelWorkers: 6 },
    )).toMatchObject({
      enabled: true,
      mode: 'wave',
      maxParallelWorkers: 6,
      source: 'cli',
    });
  });

  it.each([0, -1, 1.5, 17, Number.NaN])(
    'rejects invalid worker count %s',
    (value) => {
      expect(() => resolveParallelExecution(
        cfg({ enabled: true, max_parallel_workers: 2 }),
        { maxParallelWorkers: value },
      )).toThrow(ParallelExecutionConfigError);
    },
  );
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- tests/unit/parallel-execution.test.ts
```

Expected:
- Fails because `src/scheduler/parallel-execution.ts` does not exist.

- [ ] **Step 3: Implement `src/scheduler/parallel-execution.ts`**

Create:

```ts
import type { ReviewLoopConfig } from '../types.js';

export type ParallelExecutionMode = 'serial' | 'wave';
export type ParallelExecutionSource = 'default' | 'config' | 'cli';

export interface ParallelCliOverrides {
  parallel?: boolean;
  maxParallelWorkers?: number;
}

export interface ParallelExecutionDecision {
  enabled: boolean;
  mode: ParallelExecutionMode;
  maxParallelWorkers: number;
  source: ParallelExecutionSource;
  reason: string;
}

export class ParallelExecutionConfigError extends Error {
  public readonly code: 'invalid-worker-count';

  constructor(message: string) {
    super(message);
    this.name = 'ParallelExecutionConfigError';
    this.code = 'invalid-worker-count';
  }
}

export function resolveParallelExecution(
  config: Pick<ReviewLoopConfig, 'parallel'>,
  overrides: ParallelCliOverrides = {},
): ParallelExecutionDecision {
  const configParallel = config.parallel;
  const cliHasWorkerOverride = overrides.maxParallelWorkers !== undefined;
  const cliRequested = overrides.parallel === true;
  const configRequested = configParallel?.enabled === true;
  const requested = cliRequested || configRequested;

  const source: ParallelExecutionSource =
    cliRequested || cliHasWorkerOverride ? 'cli'
      : configParallel ? 'config'
        : 'default';

  const configuredWorkers = configParallel?.max_parallel_workers ?? 1;
  validateWorkerCount(configuredWorkers, 'config.parallel.max_parallel_workers');

  if (cliHasWorkerOverride) {
    validateWorkerCount(overrides.maxParallelWorkers!, '--max-parallel-workers');
  }

  const requestedWorkers = overrides.maxParallelWorkers ?? configuredWorkers;

  if (!requested) {
    return {
      enabled: false,
      mode: 'serial',
      maxParallelWorkers: 1,
      source,
      reason: 'parallel execution disabled',
    };
  }

  if (requestedWorkers <= 1) {
    return {
      enabled: true,
      mode: 'serial',
      maxParallelWorkers: 1,
      source,
      reason: 'parallel requested but maxParallelWorkers is 1',
    };
  }

  return {
    enabled: true,
    mode: 'wave',
    maxParallelWorkers: requestedWorkers,
    source,
    reason: 'parallel wave execution requested',
  };
}

function validateWorkerCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new ParallelExecutionConfigError(
      `${label} must be an integer from 1 to 16, got ${value}`,
    );
  }
}
```

- [ ] **Step 4: Run resolver tests**

Run:

```bash
npm test -- tests/unit/parallel-execution.test.ts
```

Expected:
- All resolver tests pass.

---

## Task 2: Add CLI Flag Plumbing

**Files:**
- Modify: `src/cli/start.ts`
- Modify: `tests/integration/no-commit-bypass.test.ts`

- [ ] **Step 1: Extend Commander parsing test**

In `tests/integration/no-commit-bypass.test.ts`, extend the existing test named `Commander parses --no-commit as { commit: false }` with:

```ts
const cmd3 = createStartCommand();
cmd3.exitOverride();
cmd3.action(() => { /* no-op */ });
cmd3.parse(['--request', 'noop', '--parallel', '--max-parallel-workers', '3'], { from: 'user' });
expect(cmd3.opts().parallel).toBe(true);
expect(cmd3.opts().maxParallelWorkers).toBe(3);
```

- [ ] **Step 2: Add CLI flags in `src/cli/start.ts`**

Add to the options chain:

```ts
.option('--parallel', 'Explicitly request Phase 8D parallel task-graph execution')
.option('--max-parallel-workers <n>', 'Max parallel task workers (1-16)', parseInt)
```

Update the header comment with:

```ts
 * --parallel               Request parallel task-graph execution (explicit opt-in)
 * --max-parallel-workers   Max parallel task workers, 1..16
```

- [ ] **Step 3: Add validation in `executeStart`**

After max-iterations validation:

```ts
if (
  options.maxParallelWorkers !== undefined
  && (!Number.isInteger(options.maxParallelWorkers)
    || options.maxParallelWorkers < 1
    || options.maxParallelWorkers > 16)
) {
  throw new Error('max-parallel-workers must be an integer from 1 to 16');
}
```

- [ ] **Step 4: Pass options into `runOrchestrator`**

Add to the `runOrchestrator` call:

```ts
parallel: options.parallel === true,
max_parallel_workers: options.maxParallelWorkers,
```

Update `StartOptions`:

```ts
parallel?: boolean;
maxParallelWorkers?: number;
```

- [ ] **Step 5: Run the CLI parsing test**

Run:

```bash
npm test -- tests/integration/no-commit-bypass.test.ts
```

Expected:
- Existing tests still pass.
- New parse assertions pass.

---

## Task 3: Add Orchestrator Fail-Closed Guard

**Files:**
- Modify: `src/orchestrator/run-orchestrator.ts`
- Test: `tests/unit/parallel-execution.test.ts`

- [ ] **Step 1: Add params to `runOrchestrator`**

In the inline params type for `runOrchestrator`, add:

```ts
parallel?: boolean;
max_parallel_workers?: number;
```

- [ ] **Step 2: Import resolver**

Add:

```ts
import { resolveParallelExecution, ParallelExecutionConfigError } from '../scheduler/parallel-execution.js';
```

- [ ] **Step 3: Resolve after config load**

Immediately after successful `loadConfigWithDefaults(...)`, add:

```ts
let parallelDecision;
try {
  parallelDecision = resolveParallelExecution(config, {
    parallel: params.parallel,
    maxParallelWorkers: params.max_parallel_workers,
  });
} catch (err) {
  if (err instanceof ParallelExecutionConfigError) {
    return makeBlockedResult('', projectRoot, `Parallel configuration error: ${err.message}`, 'CONFIG_ERROR');
  }
  throw err;
}

if (parallelDecision.mode === 'wave') {
  return makeBlockedResult(
    '',
    projectRoot,
    `Parallel wave execution was requested (${parallelDecision.source}, maxParallelWorkers=${parallelDecision.maxParallelWorkers}) but worktree-backed wave execution is not wired yet. Leave parallel.enabled false or use --max-parallel-workers 1 until Phase 8D P5 Round 2C.`,
    'CONFIG_ERROR',
  );
}
```

This is intentionally fail-closed. Do not silently fall back to serial when `mode === 'wave'`.

- [ ] **Step 4: Add a resolver test for the guard decision**

Add this test to `tests/unit/parallel-execution.test.ts`:

```ts
it('marks explicit wave requests so orchestrator can fail closed until wiring exists', () => {
  const decision = resolveParallelExecution(
    cfg({ enabled: true, max_parallel_workers: 2 }),
  );
  expect(decision.mode).toBe('wave');
  expect(decision.reason).toBe('parallel wave execution requested');
});
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npm test -- tests/unit/parallel-execution.test.ts tests/integration/no-commit-bypass.test.ts
```

Expected:
- Both test files pass.

---

## Task 4: Verify Scope and Gates

**Files:**
- All changed files.

- [ ] **Step 1: Confirm changed files**

Run:

```bash
git diff --name-only
```

Expected source/test changes:

```text
src/cli/start.ts
src/orchestrator/run-orchestrator.ts
src/scheduler/parallel-execution.ts
tests/integration/no-commit-bypass.test.ts
tests/unit/parallel-execution.test.ts
```

`.agent` artifacts may change during the review-loop run. No `src/orchestrator/task-graph-loop.ts`, prompts, worktree, resume, or `.agent/task-runs` changes are allowed.

- [ ] **Step 2: Run engineering gates**

Run:

```bash
npm run typecheck
npm run lint
npm run build
npm test
git diff --check
```

Expected:
- Every command exits 0.

---

## Review-Loop Start Request

Use this request text:

```text
Implement Phase 8D P5 Round 2B only: explicit parallel opt-in resolver + CLI plumbing + fail-closed orchestrator guard.

Read and follow docs/superpowers/plans/2026-06-19-phase-8d-p5-round2b-parallel-opt-in-seam.md.

Hard scope:
- Create src/scheduler/parallel-execution.ts.
- Create tests/unit/parallel-execution.test.ts.
- Modify src/cli/start.ts only for --parallel and --max-parallel-workers parsing/validation/plumbing.
- Modify src/orchestrator/run-orchestrator.ts only to accept CLI overrides, resolve the decision after config load, and fail closed when decision.mode === 'wave'.
- Modify tests/integration/no-commit-bypass.test.ts only to extend Commander parsing coverage.
- Do not modify src/orchestrator/task-graph-loop.ts.
- Do not call runWaveExecutorCore from run-orchestrator yet.
- Do not create worktrees.
- Do not run parallel Developer/Auditor agents.
- Do not add resume behavior or .agent/task-runs.
- Do not change prompts.

Acceptance:
- Default no flags + default config remains serial and behavior-compatible.
- max_parallel_workers alone does not enable parallelism.
- --max-parallel-workers alone does not enable parallelism.
- --parallel or config.parallel.enabled is required for opt-in.
- enabled + workers > 1 resolves to wave mode.
- runOrchestrator fails closed with a clear CONFIG_ERROR message for wave mode until Round 2C wires real worktree-backed execution.
- CLI parses --parallel and --max-parallel-workers.
- Invalid CLI worker count rejects before orchestrator work.
- Engineering gates pass: npm run typecheck, npm run lint, npm run build, npm test, git diff --check.
```

---

## Self-Review

- Spec coverage: This plan advances P5 without claiming real parallel execution. It covers explicit opt-in, CLI plumbing, worker validation, and fail-closed behavior for requested-but-unwired wave mode.
- Placeholder scan: No placeholder tasks remain; each code-changing step includes concrete APIs or snippets.
- Type consistency: CLI uses Commander camelCase `maxParallelWorkers`; orchestrator params use existing snake_case style `max_parallel_workers`; config continues to use `parallel.max_parallel_workers`.
- Scope control: The plan explicitly forbids `task-graph-loop.ts`, worktrees, prompts, resume, and `.agent/task-runs` changes.
