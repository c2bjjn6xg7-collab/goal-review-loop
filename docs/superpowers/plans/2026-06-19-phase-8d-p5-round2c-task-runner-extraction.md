# Phase 8D P5 Round 2C Task Runner Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the serial per-task Developer/verification attempt loop from `runTaskGraphLoop` into a reusable helper, without changing task-graph behavior or enabling wave execution yet.

**Architecture:** Round 2A added `runWaveExecutorCore`; Round 2B added explicit parallel opt-in and a fail-closed guard. Round 2C prepares the next wiring step by isolating one task's serial execution into `runTaskGraphTaskSerial(...)` inside `src/orchestrator/task-graph-loop.ts`. The existing outer serial loop still owns task ordering, `current_task_index`, task result persistence, integration verification, audit, finalization, and the Round 2B wave guard remains unchanged.

**Tech Stack:** TypeScript, existing task-graph orchestrator code, Vitest integration tests, fake-agent fixture.

---

## Scope

**In scope**
- Modify `src/orchestrator/task-graph-loop.ts`.
- Add a structural unit test proving the per-task attempt loop moved into `runTaskGraphTaskSerial`.
- Strengthen existing task-graph integration coverage for result order and attempt counts.
- Preserve all existing serial behavior.

**Out of scope**
- Do not modify `src/orchestrator/run-orchestrator.ts`.
- Do not modify `src/cli/start.ts`.
- Do not remove the Round 2B fail-closed wave guard.
- Do not call `runWaveExecutorCore` from the orchestrator yet.
- Do not create worktrees.
- Do not run Developer/Auditor agents in parallel.
- Do not add resume behavior.
- Do not add `.agent/task-runs`.
- Do not change prompts.
- Do not change `current_task_index` semantics.

This round is deliberately a refactor-only bridge. It should make Round 2D smaller and safer.

---

## File Structure

- Modify: `src/orchestrator/task-graph-loop.ts`
  - Add exported interfaces:
    - `RunTaskGraphTaskSerialParams`
    - `RunTaskGraphTaskSerialResult`
  - Add exported helper:
    - `runTaskGraphTaskSerial(params)`
  - Replace the inline per-task attempt loop in `runTaskGraphLoop` with one helper call.
- Create: `tests/unit/task-graph-loop-structure.test.ts`
  - Structural regression test for the extraction seam.
- Modify: `tests/integration/task-graph.test.ts`
  - Strengthen existing serial behavior assertions.

---

## Task 1: Add Structural Test for the Extraction Seam

**Files:**
- Create: `tests/unit/task-graph-loop-structure.test.ts`

- [ ] **Step 1: Add a failing structure test**

Create `tests/unit/task-graph-loop-structure.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTaskGraphTaskSerial } from '../../src/orchestrator/task-graph-loop.js';

describe('task graph loop structure', () => {
  it('exports the serial per-task runner helper', () => {
    expect(typeof runTaskGraphTaskSerial).toBe('function');
  });

  it('keeps the per-task attempt loop inside runTaskGraphTaskSerial, not runTaskGraphLoop', () => {
    const source = readFileSync(join(process.cwd(), 'src/orchestrator/task-graph-loop.ts'), 'utf8');
    const helperStart = source.indexOf('export async function runTaskGraphTaskSerial');
    const loopStart = source.indexOf('export async function runTaskGraphLoop');
    const helpersMarker = source.indexOf('// ─── Phase 8B: Task Graph helpers');

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(loopStart).toBeGreaterThanOrEqual(0);
    expect(helpersMarker).toBeGreaterThan(loopStart);

    const helperBody = source.slice(helperStart, loopStart);
    const loopBody = source.slice(loopStart, helpersMarker);

    expect(helperBody).toMatch(/for \\(let attempt = 1; attempt <= maxIterations; attempt\\+\\+\\)/);
    expect(loopBody).toContain('runTaskGraphTaskSerial({');
    expect(loopBody).not.toMatch(/for \\(let attempt = 1; attempt <= maxIterations; attempt\\+\\+\\)/);
  });
});
```

- [ ] **Step 2: Run the failing structural test**

Run:

```bash
npm test -- tests/unit/task-graph-loop-structure.test.ts
```

Expected:
- Fails because `runTaskGraphTaskSerial` is not exported yet and the attempt loop is still inline in `runTaskGraphLoop`.

---

## Task 2: Strengthen Existing Serial Behavior Coverage

**Files:**
- Modify: `tests/integration/task-graph.test.ts`

- [ ] **Step 1: Add task result order and attempt count assertions**

In the test `executes all tasks in topological order and ends in PASSED`, after:

```ts
expect(tr.results).toHaveLength(3);
expect(tr.results.every((r: { status: string }) => r.status === 'passed')).toBe(true);
```

add:

```ts
expect(tr.results.map((r: { task_id: string }) => r.task_id)).toEqual(['task-1', 'task-2', 'task-3']);
expect(tr.results.map((r: { attempts: number }) => r.attempts)).toEqual([1, 1, 1]);
expect(tr.results.every((r: { verification_passed: boolean }) => r.verification_passed === true)).toBe(true);
```

- [ ] **Step 2: Run the task graph integration test before refactor**

Run:

```bash
npm test -- tests/integration/task-graph.test.ts
```

Expected:
- Passes before the refactor. This is a characterization test, not a red test.

---

## Task 3: Extract `runTaskGraphTaskSerial`

**Files:**
- Modify: `src/orchestrator/task-graph-loop.ts`

- [ ] **Step 1: Export parameter/result interfaces**

Add these interfaces above `runTaskGraphLoop`:

```ts
export interface RunTaskGraphTaskSerialParams {
  projectRoot: string;
  agentDir: string;
  runId: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  currentBranch: string;
  baseCommit: string;
  taskGraph: TaskGraph;
  task: TaskNode;
  taskIndex: number;
  taskTotal: number;
  tgState: TaskGraphState;
  maxIterations: number;
  combinedSignal: AbortSignal;
  goalPath: string;
  handoffPath: string;
  goalSuccessCriteria: string[];
}

export interface RunTaskGraphTaskSerialResult {
  passed: boolean;
  error: string | null;
  terminalResult?: OrchestratorResult;
}
```

Use existing imported types. If `TaskNode` is not imported yet, add it to the existing import from `../types.js`.

- [ ] **Step 2: Move the attempt loop into the helper**

Add this helper above `runTaskGraphLoop`:

```ts
export async function runTaskGraphTaskSerial(
  params: RunTaskGraphTaskSerialParams,
): Promise<RunTaskGraphTaskSerialResult> {
  const {
    projectRoot,
    agentDir,
    runId,
    stateStore,
    artifactStore,
    orchestratorRegistry,
    config,
    currentBranch,
    baseCommit,
    taskGraph,
    task,
    taskIndex,
    taskTotal,
    tgState,
    maxIterations,
    combinedSignal,
    goalPath,
    handoffPath,
    goalSuccessCriteria,
  } = params;
  const taskIndexDisplay = taskIndex + 1;
  const taskVerificationCommands = normalizeGoalCommands(task.verification_commands);
  let taskPassed = false;
  let taskError: string | null = null;

  for (let attempt = 1; attempt <= maxIterations; attempt++) {
    // Move the existing inline attempt body here without changing behavior.
  }

  return { passed: taskPassed, error: taskError };
}
```

Then move the current inline block that starts with:

```ts
// Normalize task verification commands
const taskVerificationCommands = normalizeGoalCommands(task.verification_commands);

// ── Per-task Developer attempts (rework loop) ──
let taskPassed = false;
let taskError: string | null = null;

for (let attempt = 1; attempt <= maxIterations; attempt++) {
```

and ends with:

```ts
} // end per-task attempt loop
```

into `runTaskGraphTaskSerial`.

Inside the moved code:
- Replace references to `i` with `taskIndex`.
- Keep `taskIndexDisplay` as `taskIndex + 1`.
- Keep all existing calls to:
  - `buildTaskDeveloperPrompt`
  - `writePromptFile`
  - `runAgent`
  - `verifySystemProtectedPaths`
  - `validateDeveloperOutput`
  - `dispatchFeedbackBlocks`
  - `collectDiff`
  - `writeDiffArtifacts`
  - `buildTaskChangedFiles`
  - `checkScope`
  - `writeScopeReport`
  - `runVerification`
  - `appendLog`
  - `emitTaskProgress`
  - `emitProgress`
- Keep all existing retry/break/continue behavior.
- For existing early returns that return an `OrchestratorResult`, return:

```ts
return {
  passed: false,
  error: 'Run cancelled by user request',
  terminalResult: makeResult(...),
};
```

or:

```ts
return {
  passed: false,
  error: 'Verification cancelled by abort signal',
  terminalResult: makeResult(...),
};
```

using the same `makeResult(...)` arguments as the current inline code.

- [ ] **Step 3: Replace inline attempt loop with helper call**

In `runTaskGraphLoop`, after task start/progress logging, call:

```ts
const taskExecution = await runTaskGraphTaskSerial({
  projectRoot,
  agentDir,
  runId,
  stateStore,
  artifactStore,
  orchestratorRegistry,
  config,
  currentBranch,
  baseCommit,
  taskGraph,
  task,
  taskIndex: i,
  taskTotal: ordered.length,
  tgState,
  maxIterations,
  combinedSignal,
  goalPath,
  handoffPath,
  goalSuccessCriteria,
});

if (taskExecution.terminalResult) {
  return taskExecution.terminalResult;
}

const taskPassed = taskExecution.passed;
const taskError = taskExecution.error;
```

The outer loop must keep:
- cancel check before task start;
- `current_task_index` write;
- task status `running` write;
- task start append log;
- task result persistence;
- final status write;
- BLOCKED transition;
- final integration verification;
- final audit/finalization.

- [ ] **Step 4: Do not change Round 2B guard**

Confirm this command still finds no `runWaveExecutorCore` usage in `run-orchestrator.ts`:

```bash
rg -n "runWaveExecutorCore" src/orchestrator/run-orchestrator.ts || true
```

Expected:
- No matches.

---

## Task 4: Run Targeted Regression Tests

**Files:**
- `src/orchestrator/task-graph-loop.ts`
- `tests/unit/task-graph-loop-structure.test.ts`
- `tests/integration/task-graph.test.ts`

- [ ] **Step 1: Run structural test**

Run:

```bash
npm test -- tests/unit/task-graph-loop-structure.test.ts
```

Expected:
- Passes.

- [ ] **Step 2: Run task graph integration tests**

Run:

```bash
npm test -- tests/integration/task-graph.test.ts
```

Expected:
- Passes.
- Sequential task graph behavior remains unchanged.

- [ ] **Step 3: Run related P5 tests**

Run:

```bash
npm test -- tests/unit/wave-executor.test.ts tests/unit/parallel-execution.test.ts
```

Expected:
- Passes.

---

## Task 5: Run Full Gates

**Files:**
- All changed files.

- [ ] **Step 1: Confirm changed files**

Run:

```bash
git diff --name-only
```

Expected source/test changes:

```text
src/orchestrator/task-graph-loop.ts
tests/integration/task-graph.test.ts
tests/unit/task-graph-loop-structure.test.ts
```

No `src/orchestrator/run-orchestrator.ts`, `src/cli/start.ts`, prompts, worktree manager, `.agent/task-runs`, or config changes are allowed in this round.

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
Implement Phase 8D P5 Round 2C only: extract the serial per-task task-graph runner helper.

Read and follow docs/superpowers/plans/2026-06-19-phase-8d-p5-round2c-task-runner-extraction.md.

Hard scope:
- Modify src/orchestrator/task-graph-loop.ts to export RunTaskGraphTaskSerialParams, RunTaskGraphTaskSerialResult, and runTaskGraphTaskSerial.
- Move the existing per-task Developer/verification attempt loop into runTaskGraphTaskSerial.
- Keep runTaskGraphLoop as the owner of task ordering, current_task_index, task-result persistence, BLOCKED transition, integration verification, audit, and finalization.
- Create tests/unit/task-graph-loop-structure.test.ts.
- Modify tests/integration/task-graph.test.ts only to strengthen serial task result assertions.
- Do not modify src/orchestrator/run-orchestrator.ts.
- Do not modify src/cli/start.ts.
- Do not call runWaveExecutorCore from the orchestrator yet.
- Do not create worktrees.
- Do not run Developer/Auditor agents in parallel.
- Do not add resume behavior or .agent/task-runs.
- Do not change prompts.
- Do not change current_task_index semantics.

Acceptance:
- runTaskGraphTaskSerial is exported and contains the per-task attempt loop.
- runTaskGraphLoop calls runTaskGraphTaskSerial and no longer contains the attempt loop.
- Existing serial task graph integration tests pass.
- Task result order remains task-1, task-2, task-3 with attempts [1,1,1] in the passing fake-agent integration test.
- Round 2B fail-closed wave guard remains untouched; run-orchestrator does not call runWaveExecutorCore.
- Engineering gates pass: npm run typecheck, npm run lint, npm run build, npm test, git diff --check.
```

---

## Self-Review

- Spec coverage: This plan advances P5 by extracting the per-task runner seam, which is required before safe wave wiring.
- Placeholder scan: No placeholder tasks remain; code snippets include concrete interface names, helper names, commands, and expected outcomes.
- Type consistency: The helper uses existing `TaskNode`, `TaskGraph`, `TaskGraphState`, `OrchestratorResult`, and orchestrator helper types already available in `task-graph-loop.ts`.
- Scope control: The plan explicitly forbids wave wiring, worktrees, resume, prompts, and Round 2B guard changes.
