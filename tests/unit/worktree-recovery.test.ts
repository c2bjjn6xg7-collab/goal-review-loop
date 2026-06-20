/**
 * Unit tests for src/scheduler/worktree-recovery.ts — Phase 8D P7.
 *
 * `classifyRunWorktrees()` and `formatWorktreeRecoveryReport()` are the pure
 * worktree recovery layer. They classify run worktrees into keep, cleanup,
 * unknown, and no-state categories and format short diagnostic summaries
 * without invoking git or deleting files.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyRunWorktrees,
  formatWorktreeRecoveryReport,
} from '../../src/scheduler/worktree-recovery.js';
import type { WorktreeInfo } from '../../src/scheduler/worktree-manager.js';
import type { TaskGraph, TaskGraphState, TaskStatus } from '../../src/types.js';

function makeWorktree(taskId: string, overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    taskId,
    branch: `agent/run-001/${taskId}`,
    worktreePath: `/repo/.agent/worktrees/run-001/${taskId}`,
    baseCommit: 'abc123',
    ...overrides,
  };
}

function makeGraph(taskIds: string[]): TaskGraph {
  return {
    schema_version: 1,
    run_id: 'run-001',
    goal_digest: 'sha256:abc123def456abc123def456abc123def456abc123def456abc123def456ab12',
    tasks: taskIds.map((id) => ({
      id,
      title: id,
      description: `Does ${id}`,
      difficulty: 'low',
      risk: 'low',
      parallelizable: false,
      depends_on: [],
      allowed_changes: ['src/a/**'],
      disallowed_changes: ['.git/**'],
      verification_commands: [
        { id: 'vc-1', command: ['npm', 'test'], cwd: '.', required: true, timeout_seconds: 60 },
      ],
      status: 'pending',
    })),
    created_at: '2026-06-17T00:00:00Z',
  };
}

function makeState(statuses: Record<string, TaskStatus>): TaskGraphState {
  return {
    current_task_index: 0,
    task_statuses: statuses,
    task_attempts: {},
  };
}

describe('classifyRunWorktrees', () => {
  it('classifies every worktree as no_task_graph_state when graph and state are missing', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('task-1'), makeWorktree('task-2')],
      taskGraph: null,
      taskGraphState: null,
    });

    expect(report.items).toHaveLength(2);
    expect(report.items.every((item) => item.category === 'no_task_graph_state')).toBe(true);
    expect(report.counts.no_task_graph_state).toBe(2);
    expect(report.counts.keep_for_resume).toBe(0);
    expect(report.counts.cleanup_candidate).toBe(0);
    expect(report.counts.unknown_task).toBe(0);
    expect(report.hasManualAction).toBe(true);
  });

  it('classifies every worktree as no_task_graph_state when only the graph is present', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('task-1')],
      taskGraph: makeGraph(['task-1']),
      taskGraphState: null,
    });

    expect(report.items[0].category).toBe('no_task_graph_state');
    expect(report.counts.no_task_graph_state).toBe(1);
  });

  it('classifies every worktree as no_task_graph_state when only the state is present', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('task-1')],
      taskGraph: undefined,
      taskGraphState: makeState({ 'task-1': 'pending' }),
    });

    expect(report.items[0].category).toBe('no_task_graph_state');
    expect(report.counts.no_task_graph_state).toBe(1);
  });

  it('classifies worktrees for tasks not in the graph as unknown_task', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('ghost')],
      taskGraph: makeGraph(['task-1']),
      taskGraphState: makeState({ 'task-1': 'pending' }),
    });

    expect(report.items[0].category).toBe('unknown_task');
    expect(report.counts.unknown_task).toBe(1);
  });

  it('classifies passed and skipped tasks as cleanup_candidate', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('task-1'), makeWorktree('task-2')],
      taskGraph: makeGraph(['task-1', 'task-2']),
      taskGraphState: makeState({ 'task-1': 'passed', 'task-2': 'skipped' }),
    });

    expect(report.items.map((i) => i.category)).toEqual([
      'cleanup_candidate',
      'cleanup_candidate',
    ]);
    expect(report.counts.cleanup_candidate).toBe(2);
  });

  it('classifies failed, running, blocked, and pending tasks as keep_for_resume', () => {
    const statuses: Record<string, TaskStatus> = {
      'task-failed': 'failed',
      'task-running': 'running',
      'task-blocked': 'blocked',
      'task-pending': 'pending',
    };
    const report = classifyRunWorktrees({
      worktrees: [
        makeWorktree('task-failed'),
        makeWorktree('task-running'),
        makeWorktree('task-blocked'),
        makeWorktree('task-pending'),
      ],
      taskGraph: makeGraph(Object.keys(statuses)),
      taskGraphState: makeState(statuses),
    });

    expect(report.items.map((i) => i.category)).toEqual([
      'keep_for_resume',
      'keep_for_resume',
      'keep_for_resume',
      'keep_for_resume',
    ]);
    expect(report.counts.keep_for_resume).toBe(4);
  });

  it('classifies a recognized task with an unrecognized status as unknown_task', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('task-1')],
      taskGraph: makeGraph(['task-1']),
      taskGraphState: makeState({ 'task-1': 'wat' as unknown as TaskStatus }),
    });

    expect(report.items[0].category).toBe('unknown_task');
    expect(report.counts.unknown_task).toBe(1);
  });

  it('classifies a recognized task missing a status entry as unknown_task', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('task-1')],
      taskGraph: makeGraph(['task-1']),
      taskGraphState: makeState({ 'task-2': 'pending' }),
    });

    expect(report.items[0].category).toBe('unknown_task');
    expect(report.counts.unknown_task).toBe(1);
  });

  it('classifies a mixed batch and aggregates counts correctly', () => {
    const report = classifyRunWorktrees({
      worktrees: [
        makeWorktree('task-keep'),
        makeWorktree('task-done'),
        makeWorktree('task-ghost'),
      ],
      taskGraph: makeGraph(['task-keep', 'task-done']),
      taskGraphState: makeState({ 'task-keep': 'running', 'task-done': 'passed' }),
    });

    expect(report.items.map((i) => i.category)).toEqual([
      'keep_for_resume',
      'cleanup_candidate',
      'unknown_task',
    ]);
    expect(report.counts).toEqual({
      keep_for_resume: 1,
      cleanup_candidate: 1,
      unknown_task: 1,
      no_task_graph_state: 0,
    });
    expect(report.hasManualAction).toBe(true);
  });

  it('reports no manual action when every worktree is keep_for_resume', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('task-1'), makeWorktree('task-2')],
      taskGraph: makeGraph(['task-1', 'task-2']),
      taskGraphState: makeState({ 'task-1': 'running', 'task-2': 'pending' }),
    });

    expect(report.counts.keep_for_resume).toBe(2);
    expect(report.hasManualAction).toBe(false);
  });

  it('preserves taskId, branch, and worktreePath on every item', () => {
    const wt = makeWorktree('task-1', {
      branch: 'agent/run-001/task-1',
      worktreePath: '/repo/.agent/worktrees/run-001/task-1',
    });
    const report = classifyRunWorktrees({
      worktrees: [wt],
      taskGraph: makeGraph(['task-1']),
      taskGraphState: makeState({ 'task-1': 'failed' }),
    });

    expect(report.items[0]).toMatchObject({
      category: 'keep_for_resume',
      taskId: 'task-1',
      branch: 'agent/run-001/task-1',
      worktreePath: '/repo/.agent/worktrees/run-001/task-1',
    });
    expect(report.items[0].reason).toContain('task-1');
  });

  it('does not mutate the supplied worktrees, graph, or state', () => {
    const worktrees = [makeWorktree('task-1')];
    const taskGraph = makeGraph(['task-1']);
    const taskGraphState = makeState({ 'task-1': 'pending' });
    const worktreesSnapshot = JSON.parse(JSON.stringify(worktrees)) as WorktreeInfo[];
    const graphSnapshot = JSON.parse(JSON.stringify(taskGraph)) as TaskGraph;
    const stateSnapshot = JSON.parse(JSON.stringify(taskGraphState)) as TaskGraphState;

    classifyRunWorktrees({ worktrees, taskGraph, taskGraphState });

    expect(worktrees).toEqual(worktreesSnapshot);
    expect(taskGraph).toEqual(graphSnapshot);
    expect(taskGraphState).toEqual(stateSnapshot);
  });

  it('returns an empty report for no worktrees', () => {
    const report = classifyRunWorktrees({
      worktrees: [],
      taskGraph: makeGraph(['task-1']),
      taskGraphState: makeState({ 'task-1': 'pending' }),
    });

    expect(report.items).toEqual([]);
    expect(report.counts).toEqual({
      keep_for_resume: 0,
      cleanup_candidate: 0,
      unknown_task: 0,
      no_task_graph_state: 0,
    });
    expect(report.hasManualAction).toBe(false);
  });
});

describe('formatWorktreeRecoveryReport', () => {
  it('returns a no-worktrees line for an empty report', () => {
    const lines = formatWorktreeRecoveryReport({
      items: [],
      counts: {
        keep_for_resume: 0,
        cleanup_candidate: 0,
        unknown_task: 0,
        no_task_graph_state: 0,
      },
      hasManualAction: false,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no worktrees');
  });

  it('formats a summary line followed by one line per item', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('task-keep'), makeWorktree('task-done')],
      taskGraph: makeGraph(['task-keep', 'task-done']),
      taskGraphState: makeState({ 'task-keep': 'running', 'task-done': 'passed' }),
    });

    const lines = formatWorktreeRecoveryReport(report);

    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toContain('2 worktree(s)');
    expect(lines[0]).toContain('keep:1');
    expect(lines[0]).toContain('cleanup:1');
    expect(lines[1]).toContain('keep_for_resume');
    expect(lines[1]).toContain('task-keep');
    expect(lines[2]).toContain('cleanup_candidate');
    expect(lines[2]).toContain('task-done');
  });

  it('includes a manual-review footer when manual action is required', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('ghost')],
      taskGraph: makeGraph(['task-1']),
      taskGraphState: makeState({ 'task-1': 'pending' }),
    });

    const lines = formatWorktreeRecoveryReport(report);
    const footer = lines[lines.length - 1];

    expect(report.hasManualAction).toBe(true);
    expect(footer.toLowerCase()).toContain('manual');
    expect(footer.toLowerCase()).toContain('no worktrees');
    expect(footer.toLowerCase()).toContain('delet');
  });

  it('omits the manual-review footer when everything is keep_for_resume', () => {
    const report = classifyRunWorktrees({
      worktrees: [makeWorktree('task-1')],
      taskGraph: makeGraph(['task-1']),
      taskGraphState: makeState({ 'task-1': 'running' }),
    });

    const lines = formatWorktreeRecoveryReport(report);

    expect(report.hasManualAction).toBe(false);
    expect(lines[lines.length - 1]).not.toMatch(/manual/i);
  });
});
