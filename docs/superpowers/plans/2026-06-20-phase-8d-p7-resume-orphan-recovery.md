# Phase 8D P7 Resume + Orphan Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task-graph BLOCKED runs resumable through the CLI and add safe worktree recovery diagnostics for interrupted future worktree-backed runs.

**Architecture:** Add two pure recovery helpers (`task-graph-resume`, `worktree-recovery`) plus a thin CLI worktree diagnostics seam. Wire task-graph resume through the helper, fix the CLI recovery decision, and keep all worktree cleanup non-destructive.

**Tech Stack:** TypeScript, Node.js, Vitest, existing review-loop orchestrator/CLI/scheduler modules.

**Task Sizing Policy:** Follow `docs/superpowers/agent-task-planning-guidelines.md`. Do not split this plan below independently-buildable modules. If a future Planner/Developer run cannot complete one of the listed tasks without touching obvious companion files, widen that task's `allowed_changes` in the task graph instead of forcing a scope-blocked partial implementation.

---

## Files

- Modify: `src/cli/resume.ts` — allow `BLOCKED + task_graph_state`, call worktree recovery diagnostics on `--recover-lock`, export real decision logic.
- Create: `src/cli/resume-worktree-recovery.ts` — injectable CLI helper for prune/list/classify diagnostics.
- Create: `src/orchestrator/task-graph-resume.ts` — status-driven task-graph resume decision helper.
- Modify: `src/orchestrator/run-orchestrator.ts` — use task-graph resume decision instead of raw `current_task_index`.
- Create: `src/scheduler/worktree-recovery.ts` — pure worktree classification + formatter.
- Modify: `tests/unit/resume-decision.test.ts` — replace placeholder enum assertions with real recovery tests.
- Create: `tests/unit/task-graph-resume.test.ts` — unit tests for status-driven resume decisions.
- Create: `tests/unit/worktree-recovery.test.ts` — unit tests for classification/formatting.
- Create: `tests/unit/resume-worktree-recovery.test.ts` — unit tests for prune/list diagnostics without real git.
- Modify: `tests/integration/task-graph.test.ts` — add `executeResume()` integration test for task-graph BLOCKED resume.

---

### Task 1: Fix CLI Recovery Decision

**Files:**
- Modify: `src/cli/resume.ts`
- Modify: `tests/unit/resume-decision.test.ts`

- [ ] **Step 1: Write real failing recovery-decision tests**

Replace `tests/unit/resume-decision.test.ts` with tests that import the real function:

```ts
import { describe, expect, it } from 'vitest';
import { determineRecoveryAction } from '../../src/cli/resume.js';
import type { RunState } from '../../src/types.js';
import { Phase as PhaseEnum } from '../../src/types.js';

function state(overrides: Partial<RunState>): RunState {
  return {
    schema_version: 1,
    run_id: 'run-001',
    task_slug: 'resume-test',
    phase: PhaseEnum.DEVELOPING,
    iteration: 1,
    max_iterations: 3,
    consecutive_failure_count: 0,
    project_root: '/project',
    base_commit: 'abc123',
    branch: 'main',
    goal_digest: null,
    audited_diff_digest: null,
    started_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    last_error: null,
    cancel_requested_at: null,
    final_commit_sha: null,
    final_commit_message: null,
    finalized_at: null,
    commit_skipped: false,
    skip_reason: null,
    tag_name: null,
    tag_created: false,
    stages: {},
    task_graph_state: null,
    ...overrides,
  };
}

describe('determineRecoveryAction', () => {
  it('allows BLOCKED task-graph runs to continue from task state', () => {
    const action = determineRecoveryAction(state({
      phase: PhaseEnum.BLOCKED,
      task_graph_state: {
        current_task_index: 1,
        task_statuses: { 'task-1': 'passed', 'task-2': 'failed' },
        task_attempts: { 'task-1': 1, 'task-2': 1 },
      },
    }));

    expect(action.action).toBe('continue');
    expect(action.reason).toMatch(/task graph/i);
  });

  it('keeps monolithic BLOCKED runs blocked', () => {
    const action = determineRecoveryAction(state({ phase: PhaseEnum.BLOCKED }));
    expect(action.action).toBe('blocked');
    expect(action.reason).toMatch(/blocked/i);
  });

  it('keeps tag-only BLOCKED recovery more specific than task graph recovery', () => {
    const action = determineRecoveryAction(state({
      phase: PhaseEnum.BLOCKED,
      final_commit_sha: 'abc123',
      tag_created: false,
      tag_name: 'agent-run-001',
      task_graph_state: {
        current_task_index: 0,
        task_statuses: { 'task-1': 'failed' },
        task_attempts: { 'task-1': 1 },
      },
    }));

    expect(action.action).toBe('continue');
    expect(action.reason).toMatch(/tag/i);
  });

  it('continues normal in-progress phases', () => {
    expect(determineRecoveryAction(state({ phase: PhaseEnum.VERIFYING })).action).toBe('continue');
    expect(determineRecoveryAction(state({ phase: PhaseEnum.AUDITING })).action).toBe('continue');
    expect(determineRecoveryAction(state({ phase: PhaseEnum.FINALIZING })).action).toBe('continue');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- --run tests/unit/resume-decision.test.ts
```

Expected: FAIL because `determineRecoveryAction` is not exported and/or `BLOCKED + task_graph_state` returns `blocked`.

- [ ] **Step 3: Export and fix `determineRecoveryAction`**

In `src/cli/resume.ts`, export the interfaces/function:

```ts
export interface RecoveryAction {
  action: 'continue' | 'restart' | 'blocked';
  reason?: string;
}

export function determineRecoveryAction(state: RunState): RecoveryAction {
```

Update the `BLOCKED` case:

```ts
case PhaseEnum.BLOCKED: {
  if (state.final_commit_sha && !state.tag_created && state.tag_name) {
    return { action: 'continue', reason: 'Commit exists but tag failed — can retry tag creation.' };
  }
  if (state.task_graph_state) {
    return { action: 'continue', reason: 'Task graph blocked on a task — can resume from the saved task state.' };
  }
  return { action: 'blocked', reason: 'Run is blocked. Resolve the blocking issue manually.' };
}
```

- [ ] **Step 4: Verify targeted test passes**

Run:

```bash
npm test -- --run tests/unit/resume-decision.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/resume.ts tests/unit/resume-decision.test.ts
git commit -m "fix(phase-8d/p7): allow task-graph blocked resume"
```

---

### Task 2: Task-Graph Resume Decision Helper

**Files:**
- Create: `src/orchestrator/task-graph-resume.ts`
- Create: `tests/unit/task-graph-resume.test.ts`
- Modify: `src/orchestrator/run-orchestrator.ts`

- [ ] **Step 1: Write failing helper tests**

Create `tests/unit/task-graph-resume.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveTaskGraphResumeDecision } from '../../src/orchestrator/task-graph-resume.js';
import type { TaskGraph, TaskGraphState, TaskNode, TaskStatus } from '../../src/types.js';

function task(id: string, depends_on: string[] = [], status: TaskStatus = 'pending'): TaskNode {
  return {
    id,
    title: id,
    description: `${id} description`,
    difficulty: 'medium',
    risk: 'medium',
    parallelizable: true,
    depends_on,
    allowed_changes: ['src/**'],
    disallowed_changes: [],
    verification_commands: [],
    status,
  };
}

function graph(tasks: TaskNode[]): TaskGraph {
  return {
    schema_version: 1,
    run_id: 'run-001',
    goal_digest: 'sha256:' + 'a'.repeat(64),
    tasks,
    created_at: '2026-06-20T00:00:00.000Z',
  };
}

function tgState(statuses: Record<string, TaskStatus>): TaskGraphState {
  return {
    current_task_index: 0,
    task_statuses: statuses,
    task_attempts: Object.fromEntries(Object.keys(statuses).map((id) => [id, 1])),
  };
}

describe('resolveTaskGraphResumeDecision', () => {
  it('starts at task 0 when task graph state is missing', () => {
    const decision = resolveTaskGraphResumeDecision(graph([task('task-1')]), null);
    expect(decision).toMatchObject({
      kind: 'resume_task',
      taskIndex: 0,
      taskId: 'task-1',
    });
    expect(decision.reason).toMatch(/no task_graph_state/i);
  });

  it('picks the earliest failed/running/blocked task in topological order', () => {
    const decision = resolveTaskGraphResumeDecision(
      graph([task('task-1'), task('task-2', ['task-1']), task('task-3', ['task-2'])]),
      tgState({ 'task-1': 'passed', 'task-2': 'running', 'task-3': 'failed' }),
    );
    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(1);
    expect(decision.taskId).toBe('task-2');
    expect(decision.reason).toMatch(/running/);
  });

  it('falls back to earliest pending task when no failed/running/blocked task exists', () => {
    const decision = resolveTaskGraphResumeDecision(
      graph([task('task-1'), task('task-2')]),
      tgState({ 'task-1': 'passed', 'task-2': 'pending' }),
    );
    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(1);
    expect(decision.taskId).toBe('task-2');
    expect(decision.reason).toMatch(/pending/);
  });

  it('returns all_tasks_complete with taskIndex equal to ordered length', () => {
    const decision = resolveTaskGraphResumeDecision(
      graph([task('task-1'), task('task-2')]),
      tgState({ 'task-1': 'passed', 'task-2': 'skipped' }),
    );
    expect(decision.kind).toBe('all_tasks_complete');
    expect(decision.taskIndex).toBe(2);
    expect(decision.taskId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm test -- --run tests/unit/task-graph-resume.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement helper**

Create `src/orchestrator/task-graph-resume.ts`:

```ts
import { orderedTasks } from '../scheduler/task-graph.js';
import type { TaskGraph, TaskGraphState, TaskStatus } from '../types.js';

const RESTART_STATUSES = new Set<TaskStatus>(['failed', 'running', 'blocked']);

export interface TaskGraphResumeDecision {
  kind: 'resume_task' | 'all_tasks_complete';
  taskIndex: number;
  taskId: string | null;
  reason: string;
}

export function resolveTaskGraphResumeDecision(
  taskGraph: TaskGraph,
  taskGraphState: TaskGraphState | null | undefined,
): TaskGraphResumeDecision {
  const ordered = orderedTasks(taskGraph);
  if (ordered.length === 0) {
    return {
      kind: 'all_tasks_complete',
      taskIndex: 0,
      taskId: null,
      reason: 'task graph contains no tasks; continuing to integration verification',
    };
  }

  if (!taskGraphState) {
    return {
      kind: 'resume_task',
      taskIndex: 0,
      taskId: ordered[0].id,
      reason: 'no task_graph_state; starting at first task',
    };
  }

  for (let index = 0; index < ordered.length; index++) {
    const task = ordered[index];
    const status = taskGraphState.task_statuses[task.id];
    if (RESTART_STATUSES.has(status)) {
      return {
        kind: 'resume_task',
        taskIndex: index,
        taskId: task.id,
        reason: `resuming task ${task.id} with status ${status}`,
      };
    }
  }

  for (let index = 0; index < ordered.length; index++) {
    const task = ordered[index];
    const status = taskGraphState.task_statuses[task.id];
    if (status === 'pending' || status === undefined) {
      return {
        kind: 'resume_task',
        taskIndex: index,
        taskId: task.id,
        reason: `resuming first pending task ${task.id}`,
      };
    }
  }

  return {
    kind: 'all_tasks_complete',
    taskIndex: ordered.length,
    taskId: null,
    reason: 'all task statuses are passed or skipped; continuing to integration verification',
  };
}
```

- [ ] **Step 4: Wire orchestrator resume path**

In `src/orchestrator/run-orchestrator.ts`, import:

```ts
import { resolveTaskGraphResumeDecision } from './task-graph-resume.js';
```

Replace the raw resume index block in the task-graph resume path:

```ts
const tgState = await stateStore.read();
const resumeDecision = resolveTaskGraphResumeDecision(goalValidation.taskGraph, tgState.task_graph_state);
const resumeTaskIndex = resumeDecision.taskIndex;
```

After the existing resume-start log, add:

```ts
await appendLog(
  artifactStore,
  runId,
  startIteration,
  'RESUMING',
  'task graph resume decision',
  'PASS',
  resumeDecision.reason,
);
```

Keep the existing `forceTransitionForResume(PhaseEnum.DEVELOPING)` when `tgState.phase === PhaseEnum.BLOCKED`.

- [ ] **Step 5: Verify targeted tests**

Run:

```bash
npm test -- --run tests/unit/task-graph-resume.test.ts tests/integration/task-graph.test.ts -t "resumes from the failed task index"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/task-graph-resume.ts src/orchestrator/run-orchestrator.ts tests/unit/task-graph-resume.test.ts
git commit -m "feat(phase-8d/p7): resolve task graph resume index"
```

---

### Task 3: CLI `executeResume()` Integration Coverage

**Files:**
- Modify: `tests/integration/task-graph.test.ts`

- [ ] **Step 1: Add failing CLI-level resume test**

Update the imports at the top of `tests/integration/task-graph.test.ts`:

```ts
import { executeResume } from '../../src/cli/resume.js';
```

Add this test inside `describe('Phase 8B: Task Graph resume', ...)`:

```ts
it('CLI resume resumes a BLOCKED task-graph run through executeResume', async () => {
  repoDir = createTestRepo('seq-cli-resume', {
    planner: 'task-graph',
    developer: 'task-block-once',
  });

  const first = await runOrchestrator({
    project_root: repoDir,
    request: 'Add a multi-part feature',
    task_slug: 'cli-resume-test',
    max_iterations: 1,
  });
  expect(first.phase).toBe('BLOCKED');

  const stateBefore = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
  expect(stateBefore.phase).toBe('BLOCKED');
  expect(stateBefore.task_graph_state.current_task_index).toBe(0);
  expect(stateBefore.task_graph_state.task_statuses['task-1']).toBe('failed');

  await executeResume({ project_root: repoDir });

  const stateAfter = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
  expect(stateAfter.phase).toBe('PASSED');
  expect(Object.values(stateAfter.task_graph_state.task_statuses).every((status) => status === 'passed')).toBe(true);
}, 180000);
```

- [ ] **Step 2: Run the test**

Run:

```bash
npm test -- --run tests/integration/task-graph.test.ts -t "CLI resume resumes"
```

Expected after Tasks 1-2: PASS. If it fails on a stale lock, inspect `runOrchestrator` lock release rather than deleting test assertions.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/task-graph.test.ts
git commit -m "test(phase-8d/p7): cover cli task graph resume"
```

---

### Task 4: Worktree Recovery Classifier

**Files:**
- Create: `src/scheduler/worktree-recovery.ts`
- Create: `tests/unit/worktree-recovery.test.ts`

- [ ] **Step 1: Write failing classifier tests**

Create `tests/unit/worktree-recovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyRunWorktrees, formatWorktreeRecoveryReport } from '../../src/scheduler/worktree-recovery.js';
import type { WorktreeInfo } from '../../src/scheduler/worktree-manager.js';
import type { TaskGraph, TaskGraphState, TaskNode, TaskStatus } from '../../src/types.js';

function worktree(taskId: string): WorktreeInfo {
  return {
    taskId,
    branch: `agent/run-001/${taskId}-demo`,
    worktreePath: `/repo/.agent/worktrees/run-001/${taskId}`,
    baseCommit: 'abc123',
  };
}

function task(id: string): TaskNode {
  return {
    id,
    title: id,
    description: id,
    difficulty: 'medium',
    risk: 'medium',
    parallelizable: true,
    depends_on: [],
    allowed_changes: ['src/**'],
    disallowed_changes: [],
    verification_commands: [],
    status: 'pending',
  };
}

function graph(ids: string[]): TaskGraph {
  return {
    schema_version: 1,
    run_id: 'run-001',
    goal_digest: 'sha256:' + 'a'.repeat(64),
    tasks: ids.map(task),
    created_at: '2026-06-20T00:00:00.000Z',
  };
}

function state(statuses: Record<string, TaskStatus>): TaskGraphState {
  return {
    current_task_index: 0,
    task_statuses: statuses,
    task_attempts: Object.fromEntries(Object.keys(statuses).map((id) => [id, 1])),
  };
}

describe('classifyRunWorktrees', () => {
  it('classifies keep, cleanup, and unknown worktrees', () => {
    const report = classifyRunWorktrees({
      worktrees: [worktree('task-1'), worktree('task-2'), worktree('ghost')],
      taskGraph: graph(['task-1', 'task-2']),
      taskGraphState: state({ 'task-1': 'failed', 'task-2': 'passed' }),
    });

    expect(report.counts.keep_for_resume).toBe(1);
    expect(report.counts.cleanup_candidate).toBe(1);
    expect(report.counts.unknown_task).toBe(1);
    expect(report.counts.no_task_graph_state).toBe(0);
    expect(report.hasManualAction).toBe(true);
  });

  it('marks all worktrees no_task_graph_state when graph state is missing', () => {
    const report = classifyRunWorktrees({
      worktrees: [worktree('task-1')],
      taskGraph: graph(['task-1']),
      taskGraphState: null,
    });

    expect(report.items[0].category).toBe('no_task_graph_state');
    expect(report.hasManualAction).toBe(true);
  });

  it('formats short recovery summary lines', () => {
    const report = classifyRunWorktrees({
      worktrees: [worktree('task-1'), worktree('task-2')],
      taskGraph: graph(['task-1', 'task-2']),
      taskGraphState: state({ 'task-1': 'running', 'task-2': 'skipped' }),
    });

    const lines = formatWorktreeRecoveryReport(report);
    expect(lines.join('\n')).toMatch(/keep_for_resume=1/);
    expect(lines.join('\n')).toMatch(/cleanup_candidate=1/);
    expect(lines.join('\n')).toMatch(/task-1/);
    expect(lines.join('\n')).toMatch(/task-2/);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm test -- --run tests/unit/worktree-recovery.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement classifier**

Create `src/scheduler/worktree-recovery.ts`:

```ts
import type { WorktreeInfo } from './worktree-manager.js';
import type { TaskGraph, TaskGraphState, TaskStatus } from '../types.js';

export type WorktreeRecoveryCategory =
  | 'keep_for_resume'
  | 'cleanup_candidate'
  | 'unknown_task'
  | 'no_task_graph_state';

export interface WorktreeRecoveryItem {
  category: WorktreeRecoveryCategory;
  taskId: string;
  branch: string;
  worktreePath: string;
  reason: string;
}

export interface WorktreeRecoveryReport {
  items: WorktreeRecoveryItem[];
  counts: Record<WorktreeRecoveryCategory, number>;
  hasManualAction: boolean;
}

const KEEP_STATUSES = new Set<TaskStatus>(['failed', 'running', 'blocked', 'pending']);
const CLEANUP_STATUSES = new Set<TaskStatus>(['passed', 'skipped']);

function emptyCounts(): Record<WorktreeRecoveryCategory, number> {
  return {
    keep_for_resume: 0,
    cleanup_candidate: 0,
    unknown_task: 0,
    no_task_graph_state: 0,
  };
}

function item(worktree: WorktreeInfo, category: WorktreeRecoveryCategory, reason: string): WorktreeRecoveryItem {
  return {
    category,
    taskId: worktree.taskId,
    branch: worktree.branch,
    worktreePath: worktree.worktreePath,
    reason,
  };
}

export function classifyRunWorktrees(params: {
  worktrees: WorktreeInfo[];
  taskGraph: TaskGraph | null | undefined;
  taskGraphState: TaskGraphState | null | undefined;
}): WorktreeRecoveryReport {
  const counts = emptyCounts();
  const taskIds = new Set(params.taskGraph?.tasks.map((task) => task.id) ?? []);
  const items = params.worktrees.map((worktree) => {
    if (!params.taskGraph || !params.taskGraphState) {
      return item(worktree, 'no_task_graph_state', 'task graph state is missing; inspect manually before deleting');
    }
    if (!taskIds.has(worktree.taskId)) {
      return item(worktree, 'unknown_task', 'worktree task id is not present in task graph');
    }
    const status = params.taskGraphState.task_statuses[worktree.taskId];
    if (KEEP_STATUSES.has(status)) {
      return item(worktree, 'keep_for_resume', `task status is ${status}; keep for resume`);
    }
    if (CLEANUP_STATUSES.has(status)) {
      return item(worktree, 'cleanup_candidate', `task status is ${status}; cleanup may be safe after manual review`);
    }
    return item(worktree, 'unknown_task', `task status is ${String(status)}; inspect manually`);
  });

  for (const recoveryItem of items) {
    counts[recoveryItem.category] += 1;
  }

  return {
    items,
    counts,
    hasManualAction: counts.cleanup_candidate > 0 || counts.unknown_task > 0 || counts.no_task_graph_state > 0,
  };
}

export function formatWorktreeRecoveryReport(report: WorktreeRecoveryReport): string[] {
  if (report.items.length === 0) {
    return [];
  }
  const lines = [
    `Worktree recovery: keep_for_resume=${report.counts.keep_for_resume}, cleanup_candidate=${report.counts.cleanup_candidate}, unknown_task=${report.counts.unknown_task}, no_task_graph_state=${report.counts.no_task_graph_state}`,
  ];
  for (const recoveryItem of report.items) {
    lines.push(`- ${recoveryItem.category}: ${recoveryItem.taskId} (${recoveryItem.branch}) ${recoveryItem.worktreePath} — ${recoveryItem.reason}`);
  }
  return lines;
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
npm test -- --run tests/unit/worktree-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/worktree-recovery.ts tests/unit/worktree-recovery.test.ts
git commit -m "feat(phase-8d/p7): classify run worktrees"
```

---

### Task 5: `recover_lock` Worktree Diagnostics

**Files:**
- Create: `src/cli/resume-worktree-recovery.ts`
- Create: `tests/unit/resume-worktree-recovery.test.ts`
- Modify: `src/cli/resume.ts`

- [ ] **Step 1: Write failing diagnostics tests**

Create `tests/unit/resume-worktree-recovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { collectResumeWorktreeRecoveryLines } from '../../src/cli/resume-worktree-recovery.js';
import type { RunState, TaskGraph } from '../../src/types.js';
import { Phase as PhaseEnum } from '../../src/types.js';

function state(): RunState {
  return {
    schema_version: 1,
    run_id: 'run-001',
    task_slug: 'resume-test',
    phase: PhaseEnum.BLOCKED,
    iteration: 1,
    max_iterations: 3,
    consecutive_failure_count: 0,
    project_root: '/repo',
    base_commit: 'abc123',
    branch: 'main',
    goal_digest: null,
    audited_diff_digest: null,
    started_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    last_error: null,
    cancel_requested_at: null,
    final_commit_sha: null,
    final_commit_message: null,
    finalized_at: null,
    commit_skipped: false,
    skip_reason: null,
    tag_name: null,
    tag_created: false,
    stages: {},
    task_graph_state: {
      current_task_index: 0,
      task_statuses: { 'task-1': 'failed', 'task-2': 'passed' },
      task_attempts: { 'task-1': 1, 'task-2': 1 },
    },
  };
}

function taskGraph(): TaskGraph {
  return {
    schema_version: 1,
    run_id: 'run-001',
    goal_digest: 'sha256:' + 'a'.repeat(64),
    created_at: '2026-06-20T00:00:00.000Z',
    tasks: [
      { id: 'task-1', title: 'task-1', description: '', difficulty: 'medium', risk: 'medium', parallelizable: true, depends_on: [], allowed_changes: ['src/**'], disallowed_changes: [], verification_commands: [], status: 'pending' },
      { id: 'task-2', title: 'task-2', description: '', difficulty: 'medium', risk: 'medium', parallelizable: true, depends_on: [], allowed_changes: ['src/**'], disallowed_changes: [], verification_commands: [], status: 'pending' },
    ],
  };
}

describe('collectResumeWorktreeRecoveryLines', () => {
  it('prunes and formats diagnostics without deleting worktrees', async () => {
    let pruned = false;
    let cleanupCalled = false;
    const lines = await collectResumeWorktreeRecoveryLines({
      state: state(),
      taskGraph: taskGraph(),
      manager: {
        async prune() { pruned = true; },
        async listForRun(runId: string) {
          expect(runId).toBe('run-001');
          return [
            { taskId: 'task-1', branch: 'agent/run-001/task-1-demo', worktreePath: '/repo/.agent/worktrees/run-001/task-1', baseCommit: 'abc123' },
            { taskId: 'task-2', branch: 'agent/run-001/task-2-demo', worktreePath: '/repo/.agent/worktrees/run-001/task-2', baseCommit: 'abc123' },
          ];
        },
        async cleanupTask() { cleanupCalled = true; },
      },
    });

    expect(pruned).toBe(true);
    expect(cleanupCalled).toBe(false);
    expect(lines.join('\n')).toMatch(/keep_for_resume=1/);
    expect(lines.join('\n')).toMatch(/cleanup_candidate=1/);
  });

  it('returns no lines for non-task-graph state', async () => {
    const plain = state();
    plain.task_graph_state = null;
    const lines = await collectResumeWorktreeRecoveryLines({
      state: plain,
      taskGraph: taskGraph(),
      manager: {
        async prune() { throw new Error('should not prune'); },
        async listForRun() { throw new Error('should not list'); },
      },
    });
    expect(lines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm test -- --run tests/unit/resume-worktree-recovery.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement CLI diagnostics helper**

Create `src/cli/resume-worktree-recovery.ts`:

```ts
import { WorktreeManager } from '../scheduler/worktree-manager.js';
import type { WorktreeInfo } from '../scheduler/worktree-manager.js';
import { classifyRunWorktrees, formatWorktreeRecoveryReport } from '../scheduler/worktree-recovery.js';
import type { RunState, TaskGraph } from '../types.js';

export interface ResumeWorktreeRecoveryManager {
  prune(): Promise<void>;
  listForRun(runId: string): Promise<WorktreeInfo[]>;
  cleanupTask?(runId: string, taskId: string): Promise<void>;
}

export async function collectResumeWorktreeRecoveryLines(params: {
  state: RunState;
  taskGraph: TaskGraph | null | undefined;
  manager?: ResumeWorktreeRecoveryManager;
}): Promise<string[]> {
  if (!params.state.task_graph_state) {
    return [];
  }

  const manager = params.manager ?? new WorktreeManager(params.state.project_root);
  await manager.prune();
  const worktrees = await manager.listForRun(params.state.run_id);
  if (worktrees.length === 0) {
    return [];
  }

  const report = classifyRunWorktrees({
    worktrees,
    taskGraph: params.taskGraph,
    taskGraphState: params.state.task_graph_state,
  });
  return formatWorktreeRecoveryReport(report);
}
```

- [ ] **Step 4: Wire into `executeResume()`**

In `src/cli/resume.ts`, import:

```ts
import { loadTaskGraph } from '../scheduler/task-graph.js';
import { collectResumeWorktreeRecoveryLines } from './resume-worktree-recovery.js';
```

After lock handling and before `const recoveryAction = determineRecoveryAction(state);`, add:

```ts
if (params.recover_lock && state.task_graph_state) {
  const taskGraphResult = loadTaskGraph(projectRoot);
  const recoveryLines = await collectResumeWorktreeRecoveryLines({
    state,
    taskGraph: taskGraphResult.valid ? taskGraphResult.graph : null,
  });
  for (const line of recoveryLines) {
    console.log(line);
  }
}
```

Do not call `cleanupTask()` in this path.

- [ ] **Step 5: Verify diagnostics tests**

Run:

```bash
npm test -- --run tests/unit/resume-worktree-recovery.test.ts tests/unit/worktree-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/resume-worktree-recovery.ts src/cli/resume.ts tests/unit/resume-worktree-recovery.test.ts
git commit -m "feat(phase-8d/p7): report worktree recovery diagnostics"
```

---

### Task 6: Full Validation and Scope Check

**Files:**
- Verify all files from Tasks 1-5.

- [ ] **Step 1: Run targeted P7 suite**

Run:

```bash
npm test -- --run tests/unit/resume-decision.test.ts tests/unit/task-graph-resume.test.ts tests/unit/worktree-recovery.test.ts tests/unit/resume-worktree-recovery.test.ts
npm test -- --run tests/integration/task-graph.test.ts -t "resume|CLI resume"
```

Expected: PASS.

- [ ] **Step 2: Run full engineering gates**

Run:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

Expected: all PASS.

- [ ] **Step 3: Confirm non-goal files are untouched**

Run:

```bash
git diff -- src/scheduler/worktree-manager.ts src/scheduler/failure-policy.ts src/orchestrator/task-graph-loop.ts src/artifacts/config.ts src/agents/prompt-builder.ts prompts review-loop.yaml
```

Expected: no diff. If `task-graph-loop.ts` changed only because a previous task needed imports, revert it; P7 should not alter task execution semantics.

- [ ] **Step 4: Confirm final git status**

Run:

```bash
git status --short
```

Expected: clean after the task commits, with no `.agent/**` runtime artifacts staged or modified.

---

## Execution Notes for Plugin Run

Use the committed spec files as authority:

- `docs/superpowers/specs/2026-06-20-phase-8d-p7-resume-orphan-recovery-requirements.md`
- `docs/superpowers/specs/2026-06-20-phase-8d-p7-resume-orphan-recovery-design.md`

Strict scope:

- Allowed: files listed in this plan.
- Forbidden: provider/model routing, parallel executor, retry budgets, prompt templates, config schema, and automatic worktree deletion.
- Use `--no-commit` when running review-loop so the human/outer agent can independently verify and commit with P7-specific messages.
