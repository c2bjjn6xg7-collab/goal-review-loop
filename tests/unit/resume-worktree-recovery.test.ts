/**
 * Unit tests for src/cli/resume-worktree-recovery.ts — Phase 8D P7.
 *
 * `runWorktreeRecoveryDiagnostics()` is the injectable CLI helper behind
 * `resume --recover-lock`. It prunes stale git worktree metadata, lists the
 * run's worktrees, classifies them with the pure worktree-recovery layer, and
 * prints diagnostics — without ever invoking automatic task cleanup.
 *
 * Dependencies (prune + listForRun) are injected so these tests never touch git
 * or the filesystem.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runWorktreeRecoveryDiagnostics,
  type WorktreeRecoveryDeps,
} from '../../src/cli/resume-worktree-recovery.js';
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

function makeDeps(
  worktrees: WorktreeInfo[],
  overrides: Partial<WorktreeRecoveryDeps> = {},
): WorktreeRecoveryDeps & { prune: ReturnType<typeof vi.fn>; listForRun: ReturnType<typeof vi.fn> } {
  return {
    prune: vi.fn(async () => undefined),
    listForRun: vi.fn(async () => worktrees),
    ...overrides,
  };
}

describe('runWorktreeRecoveryDiagnostics', () => {
  it('prunes stale worktree metadata then lists worktrees for the run', async () => {
    const deps = makeDeps([makeWorktree('task-1')]);
    const result = await runWorktreeRecoveryDiagnostics({
      runId: 'run-001',
      taskGraph: makeGraph(['task-1']),
      taskGraphState: makeState({ 'task-1': 'running' }),
      deps,
    });

    expect(deps.prune).toHaveBeenCalledTimes(1);
    expect(deps.listForRun).toHaveBeenCalledTimes(1);
    expect(deps.listForRun).toHaveBeenCalledWith('run-001');
    expect(result.worktreeCount).toBe(1);
  });

  it('prunes before listing', async () => {
    const callOrder: string[] = [];
    const deps: WorktreeRecoveryDeps = {
      prune: async () => {
        callOrder.push('prune');
      },
      listForRun: async () => {
        callOrder.push('listForRun');
        return [makeWorktree('task-1')];
      },
    };

    await runWorktreeRecoveryDiagnostics({
      runId: 'run-001',
      taskGraph: makeGraph(['task-1']),
      taskGraphState: makeState({ 'task-1': 'running' }),
      deps,
    });

    expect(callOrder).toEqual(['prune', 'listForRun']);
  });

  it('prints formatted diagnostics when worktrees exist', async () => {
    const log = vi.fn();
    const deps = makeDeps([makeWorktree('task-1'), makeWorktree('task-2')]);

    await runWorktreeRecoveryDiagnostics({
      runId: 'run-001',
      taskGraph: makeGraph(['task-1', 'task-2']),
      taskGraphState: makeState({ 'task-1': 'running', 'task-2': 'passed' }),
      deps,
      log,
    });

    expect(log).toHaveBeenCalled();
    const firstLine = log.mock.calls[0][0] as string;
    expect(firstLine).toContain('2 worktree(s)');
    // One summary line, one per item, plus a manual-review footer (task-2
    // passed → cleanup_candidate → manual action required).
    expect(log).toHaveBeenCalledTimes(4);
  });

  it('does not print when there are no worktrees', async () => {
    const log = vi.fn();
    const deps = makeDeps([]);

    const result = await runWorktreeRecoveryDiagnostics({
      runId: 'run-001',
      taskGraph: makeGraph(['task-1']),
      taskGraphState: makeState({ 'task-1': 'pending' }),
      deps,
      log,
    });

    expect(result.worktreeCount).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('classifies worktrees using the supplied task graph and state', async () => {
    const deps = makeDeps([
      makeWorktree('task-keep'),
      makeWorktree('task-done'),
      makeWorktree('task-ghost'),
    ]);

    const result = await runWorktreeRecoveryDiagnostics({
      runId: 'run-001',
      taskGraph: makeGraph(['task-keep', 'task-done']),
      taskGraphState: makeState({ 'task-keep': 'running', 'task-done': 'passed' }),
      deps,
    });

    expect(result.report.items.map((i) => i.category)).toEqual([
      'keep_for_resume',
      'cleanup_candidate',
      'unknown_task',
    ]);
    expect(result.report.hasManualAction).toBe(true);
  });

  it('classifies all worktrees as no_task_graph_state when the graph is missing', async () => {
    const deps = makeDeps([makeWorktree('task-1')]);

    const result = await runWorktreeRecoveryDiagnostics({
      runId: 'run-001',
      taskGraph: null,
      taskGraphState: makeState({ 'task-1': 'pending' }),
      deps,
    });

    expect(result.report.counts.no_task_graph_state).toBe(1);
    expect(result.report.hasManualAction).toBe(true);
  });

  it('never invokes automatic task cleanup', async () => {
    // Even if a caller hands the helper a deps object that also exposes a
    // cleanup method, recovery diagnostics must never call it. P7 is
    // diagnostic-only; cleanup is a manual human decision.
    const cleanupTask = vi.fn(async () => undefined);
    const deps = {
      prune: vi.fn(async () => undefined),
      listForRun: vi.fn(async () => [makeWorktree('task-done')]),
      cleanupTask,
    } as unknown as WorktreeRecoveryDeps;

    const result = await runWorktreeRecoveryDiagnostics({
      runId: 'run-001',
      taskGraph: makeGraph(['task-done']),
      taskGraphState: makeState({ 'task-done': 'passed' }),
      deps,
    });

    // A passed task is a cleanup_candidate, but diagnostics must still not
    // delete anything — only surface it for manual review.
    expect(result.report.counts.cleanup_candidate).toBe(1);
    expect(cleanupTask).not.toHaveBeenCalled();
  });

  it('propagates listForRun failures so resume can surface a consistency error', async () => {
    const deps = makeDeps([], {
      listForRun: vi.fn(async () => {
        throw new Error('git worktree list failed');
      }),
    });

    await expect(
      runWorktreeRecoveryDiagnostics({
        runId: 'run-001',
        taskGraph: makeGraph(['task-1']),
        taskGraphState: makeState({ 'task-1': 'pending' }),
        deps,
      }),
    ).rejects.toThrow('git worktree list failed');
  });

  it('propagates prune failures', async () => {
    const deps = makeDeps([], {
      prune: vi.fn(async () => {
        throw new Error('git worktree prune failed');
      }),
    });

    await expect(
      runWorktreeRecoveryDiagnostics({
        runId: 'run-001',
        taskGraph: makeGraph(['task-1']),
        taskGraphState: makeState({ 'task-1': 'pending' }),
        deps,
      }),
    ).rejects.toThrow('git worktree prune failed');
  });

  it('defaults to console.log when no log sink is supplied', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const deps = makeDeps([makeWorktree('task-1')]);

      await runWorktreeRecoveryDiagnostics({
        runId: 'run-001',
        taskGraph: makeGraph(['task-1']),
        taskGraphState: makeState({ 'task-1': 'running' }),
        deps,
      });

      expect(logSpy).toHaveBeenCalled();
      expect(logSpy.mock.calls[0][0]).toContain('worktree(s)');
    } finally {
      logSpy.mockRestore();
    }
  });
});
