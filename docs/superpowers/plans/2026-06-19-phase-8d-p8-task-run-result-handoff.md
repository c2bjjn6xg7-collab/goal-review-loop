# Phase 8D P8 Task Run Result Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small, tested task-run result handoff module so future worktree workers can write `.agent/task-runs/{task_id}/result.json` back to the main scheduler safely.

**Architecture:** Keep this round storage-only and orchestration-neutral. The module writes and reads atomically formatted result JSON under the main repository's `.agent/task-runs/` directory, validates task IDs to prevent path traversal, and returns explicit missing/corrupt outcomes for scheduler code to consume later.

**Tech Stack:** TypeScript, `fs-extra`, existing `atomicWriteJSON`, Vitest.

---

## Scope

This round intentionally does **not** wire P5 wave execution, spawn workers, create worktrees, merge branches, change prompts, or change resume behavior. It only creates the result handoff file API and unit tests.

## Files

- Create: `src/scheduler/task-run-result.ts`
- Create: `tests/unit/task-run-result.test.ts`
- Modify: `src/index.ts` only if needed to export the module from the public package surface

Do not modify:

- `src/orchestrator/run-orchestrator.ts`
- `src/orchestrator/task-graph-loop.ts`
- `src/scheduler/wave-executor.ts`
- `src/scheduler/worktree-manager.ts`
- `src/cli/start.ts`
- `prompts/**`
- `.agent/task-runs/**` as checked-in files

## Data Contract

Implement these exported types and functions in `src/scheduler/task-run-result.ts`:

```ts
export type TaskRunResultStatus = 'passed' | 'failed' | 'blocked';

export interface TaskRunResult {
  schema_version: 1;
  run_id: string;
  task_id: string;
  status: TaskRunResultStatus;
  exit_code: number | null;
  final_commit_sha: string | null;
  diff_digest: string | null;
  branch: string | null;
  error: string | null;
  finished_at: string;
}

export interface MissingTaskRunResult {
  found: false;
  path: string;
  error: null;
}

export interface FoundTaskRunResult {
  found: true;
  path: string;
  result: TaskRunResult;
}

export interface InvalidTaskRunResult {
  found: false;
  path: string;
  error: TaskRunResultError;
}

export type ReadTaskRunResultOutcome =
  | MissingTaskRunResult
  | FoundTaskRunResult
  | InvalidTaskRunResult;

export class TaskRunResultError extends Error {
  code:
    | 'invalid-task-id'
    | 'invalid-result-json'
    | 'result-run-id-mismatch'
    | 'result-task-id-mismatch';
}

export function taskRunResultPath(projectRoot: string, taskId: string): string;
export async function writeTaskRunResult(projectRoot: string, result: TaskRunResult): Promise<string>;
export async function readTaskRunResult(projectRoot: string, runId: string, taskId: string): Promise<ReadTaskRunResultOutcome>;
```

Rules:

- `taskRunResultPath(projectRoot, taskId)` returns `<projectRoot>/.agent/task-runs/<taskId>/result.json`.
- `taskId` must match `/^[A-Za-z0-9._-]+$/`; reject empty IDs, `../x`, `a/b`, and IDs containing path separators with `TaskRunResultError('invalid-task-id')`.
- `writeTaskRunResult` validates `result.task_id`, writes atomically via `atomicWriteJSON`, and returns the absolute path written.
- `readTaskRunResult` validates `taskId`, returns `{ found:false, error:null }` when the file is absent, parses JSON when present, and validates `schema_version`, `run_id`, `task_id`, `status`, `exit_code`, `final_commit_sha`, `diff_digest`, `branch`, `error`, and `finished_at`.
- `readTaskRunResult` returns `result-run-id-mismatch` or `result-task-id-mismatch` when the stored IDs do not match the requested IDs.
- Do not introduce a new JSON schema dependency; implement a small local validator with readable error messages.

### Task 1: Add Result Handoff Module

**Files:**
- Create: `src/scheduler/task-run-result.ts`
- Test: `tests/unit/task-run-result.test.ts`

- [ ] **Step 1: Write tests for path validation and write/read round trip**

Create `tests/unit/task-run-result.test.ts` with tests that:

```ts
import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readTaskRunResult,
  taskRunResultPath,
  TaskRunResultError,
  writeTaskRunResult,
  type TaskRunResult,
} from '../../src/scheduler/task-run-result.js';

function makeProjectRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'task-run-result-'));
}

function makeResult(overrides: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    schema_version: 1,
    run_id: 'run-1',
    task_id: 'task-1',
    status: 'passed',
    exit_code: 0,
    final_commit_sha: 'abc123',
    diff_digest: 'sha256:abc',
    branch: 'agent/run-1/task-1-demo',
    error: null,
    finished_at: '2026-06-19T12:00:00.000Z',
    ...overrides,
  };
}
```

Cover:

```ts
it('builds the expected result.json path for a safe task id', () => {
  const root = makeProjectRoot();
  expect(taskRunResultPath(root, 'task-1')).toBe(
    path.join(root, '.agent', 'task-runs', 'task-1', 'result.json'),
  );
});

it('rejects unsafe task ids before building paths', () => {
  const root = makeProjectRoot();
  for (const bad of ['', '../x', 'a/b', 'a\\\\b']) {
    expect(() => taskRunResultPath(root, bad)).toThrow(TaskRunResultError);
  }
});

it('writes and reads a valid result atomically', async () => {
  const root = makeProjectRoot();
  const writtenPath = await writeTaskRunResult(root, makeResult());
  expect(writtenPath).toBe(taskRunResultPath(root, 'task-1'));
  const outcome = await readTaskRunResult(root, 'run-1', 'task-1');
  expect(outcome.found).toBe(true);
  if (outcome.found) expect(outcome.result).toEqual(makeResult());
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/unit/task-run-result.test.ts
```

Expected: FAIL because `src/scheduler/task-run-result.ts` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/scheduler/task-run-result.ts` with the exported contract above. Use:

```ts
import fs from 'fs-extra';
import path from 'node:path';
import { atomicWriteJSON } from '../runtime/atomic-file.js';
```

Use a private `assertSafeTaskId(taskId: string): void` with `/^[A-Za-z0-9._-]+$/`.

Use a private validator that checks:

- object is non-null and not an array
- `schema_version === 1`
- `run_id` and `task_id` are strings
- `status` is one of `passed`, `failed`, `blocked`
- `exit_code` is number or null
- `final_commit_sha`, `diff_digest`, `branch`, and `error` are string or null
- `finished_at` is a string

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/unit/task-run-result.test.ts
```

Expected: PASS.

### Task 2: Add Negative Read Tests

**Files:**
- Modify: `tests/unit/task-run-result.test.ts`

- [ ] **Step 1: Add tests for missing, malformed, and mismatched result files**

Add tests that:

- missing file returns `{ found:false, error:null }`
- malformed JSON returns `{ found:false, error.code:'invalid-result-json' }`
- wrong `run_id` returns `{ found:false, error.code:'result-run-id-mismatch' }`
- wrong `task_id` returns `{ found:false, error.code:'result-task-id-mismatch' }`
- invalid `status` returns `{ found:false, error.code:'invalid-result-json' }`

Use `fs.outputFile(...)` to write malformed/corrupt files directly to `taskRunResultPath(...)`.

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test -- tests/unit/task-run-result.test.ts
```

Expected: PASS.

### Task 3: Export and Regression Gates

**Files:**
- Modify: `src/index.ts` only if the package currently re-exports scheduler modules there
- Test: existing suite

- [ ] **Step 1: Check package export style**

Open `src/index.ts`. If it exports scheduler utilities, add:

```ts
export {
  taskRunResultPath,
  writeTaskRunResult,
  readTaskRunResult,
  TaskRunResultError,
  type TaskRunResult,
  type TaskRunResultStatus,
  type ReadTaskRunResultOutcome,
} from './scheduler/task-run-result.js';
```

If `src/index.ts` does not export comparable scheduler utilities, leave it unchanged and explain that in the developer handoff.

- [ ] **Step 2: Run required gates**

Run:

```bash
npm run typecheck
npm run lint
npm run build
npm test -- tests/unit/task-run-result.test.ts tests/unit/wave-executor.test.ts tests/unit/worktree-manager.test.ts
npm test
git diff --check
```

Expected:

- typecheck: exit 0
- lint: exit 0
- build: exit 0
- targeted tests: exit 0
- full tests: exit 0
- diff check: exit 0

## Acceptance Criteria

1. `src/scheduler/task-run-result.ts` exists and exports the documented API.
2. Safe task IDs map to `.agent/task-runs/{task_id}/result.json`.
3. Unsafe task IDs are rejected before path construction or filesystem access.
4. `writeTaskRunResult` writes valid JSON atomically and returns the result path.
5. `readTaskRunResult` distinguishes missing files from invalid/corrupt files.
6. `readTaskRunResult` detects run/task ID mismatches.
7. Unit tests cover valid round trip, missing result, malformed JSON, schema invalid result, run mismatch, task mismatch, and unsafe IDs.
8. No orchestrator, CLI, prompt, worktree, or wave executor behavior changes are introduced.
9. Engineering gates pass: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `git diff --check`.

## Review-Loop Request

Use this request text:

```text
Implement Phase 8D P8 only: task-run result handoff storage.

Read and follow docs/superpowers/plans/2026-06-19-phase-8d-p8-task-run-result-handoff.md.

Hard scope:
- Create src/scheduler/task-run-result.ts.
- Create tests/unit/task-run-result.test.ts.
- Modify src/index.ts only if needed for package export consistency.
- Do not modify src/orchestrator/run-orchestrator.ts.
- Do not modify src/orchestrator/task-graph-loop.ts.
- Do not modify src/scheduler/wave-executor.ts.
- Do not modify src/scheduler/worktree-manager.ts.
- Do not modify src/cli/start.ts.
- Do not modify prompts/**.
- Do not wire wave execution, spawn workers, create worktrees, merge branches, change resume behavior, or create checked-in .agent/task-runs files.

Acceptance:
- taskRunResultPath validates safe task IDs and returns .agent/task-runs/{task_id}/result.json.
- writeTaskRunResult writes valid result JSON atomically.
- readTaskRunResult returns found:true for valid results, found:false/error:null for missing results, and found:false/error for invalid JSON or ID mismatches.
- Tests cover valid, missing, malformed, invalid schema/status, run mismatch, task mismatch, and unsafe task ID cases.
- Engineering gates pass: npm run typecheck, npm run lint, npm run build, npm test, git diff --check.
```

## Self-Review

- Spec coverage: This implements P8's `.agent/task-runs/{task_id}/result.json` storage contract without prematurely wiring P5 concurrency.
- Placeholder scan: No placeholder tasks remain; each task has concrete files, code shape, and commands.
- Type consistency: Function/type names are consistent across the contract, tests, and export instructions.
- Scope control: Orchestrator, wave executor, worktree manager, CLI, prompts, resume, and checked-in runtime task-runs are explicitly out of scope.
