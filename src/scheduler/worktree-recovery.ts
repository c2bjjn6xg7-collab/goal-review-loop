/**
 * Worktree Recovery Classification — Phase 8D P7.
 *
 * Pure, non-destructive worktree recovery diagnostics for task-graph runs.
 * `classifyRunWorktrees()` maps each run worktree to a recovery category from
 * the saved task graph state, and `formatWorktreeRecoveryReport()` renders
 * short diagnostic summaries.
 *
 * This helper is intentionally read-only: it never invokes git, inspects dirty
 * working trees, or deletes files. Completed, dirty, unknown, and orphaned
 * worktrees are surfaced for manual review only.
 */

import type { WorktreeInfo } from './worktree-manager.js';
import type { TaskGraph, TaskGraphState } from '../types.js';

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

export interface ClassifyRunWorktreesParams {
  worktrees: WorktreeInfo[];
  taskGraph: TaskGraph | null | undefined;
  taskGraphState: TaskGraphState | null | undefined;
}

/** Finished task statuses whose worktrees are no longer needed for resume. */
const CLEANUP_STATUSES = new Set<string>(['passed', 'skipped']);
/** Unfinished task statuses whose worktrees must be kept for resume. */
const KEEP_STATUSES = new Set<string>(['failed', 'running', 'blocked', 'pending']);
/** Categories that require a human decision before any cleanup. */
const MANUAL_ACTION_CATEGORIES: ReadonlySet<WorktreeRecoveryCategory> = new Set([
  'cleanup_candidate',
  'unknown_task',
  'no_task_graph_state',
]);

function emptyCounts(): Record<WorktreeRecoveryCategory, number> {
  return {
    keep_for_resume: 0,
    cleanup_candidate: 0,
    unknown_task: 0,
    no_task_graph_state: 0,
  };
}

/**
 * Classify run worktrees into recovery categories using the saved task graph
 * state. Pure: does not mutate its inputs and does not touch the filesystem.
 *
 * Classification rules:
 *   - missing graph or state: every worktree is `no_task_graph_state`
 *   - task id not in graph: `unknown_task`
 *   - status `passed` or `skipped`: `cleanup_candidate`
 *   - status `failed`, `running`, `blocked`, or `pending`: `keep_for_resume`
 *   - unrecognized or missing status: `unknown_task`
 */
export function classifyRunWorktrees(params: ClassifyRunWorktreesParams): WorktreeRecoveryReport {
  const { worktrees, taskGraph, taskGraphState } = params;
  const items: WorktreeRecoveryItem[] = [];

  const hasGraphState = Boolean(taskGraph && taskGraphState);
  const knownTaskIds = taskGraph
    ? new Set(taskGraph.tasks.map((task) => task.id))
    : new Set<string>();
  const statuses = taskGraphState?.task_statuses ?? {};

  for (const worktree of worktrees) {
    let category: WorktreeRecoveryCategory;
    let reason: string;
    const status = statuses[worktree.taskId];

    if (!hasGraphState) {
      category = 'no_task_graph_state';
      reason = 'No task graph state available — cannot classify worktree safely.';
    } else if (!knownTaskIds.has(worktree.taskId)) {
      category = 'unknown_task';
      reason = `Task ${worktree.taskId} is not present in the task graph.`;
    } else if (CLEANUP_STATUSES.has(status ?? '')) {
      category = 'cleanup_candidate';
      reason = `Task ${worktree.taskId} finished (status: ${status}); worktree no longer needed.`;
    } else if (KEEP_STATUSES.has(status ?? '')) {
      category = 'keep_for_resume';
      reason = `Task ${worktree.taskId} is unfinished (status: ${status}); keep worktree for resume.`;
    } else {
      category = 'unknown_task';
      reason = `Task ${worktree.taskId} has unrecognized status '${status ?? '<missing>'}'.`;
    }

    items.push({
      category,
      taskId: worktree.taskId,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      reason,
    });
  }

  const counts = emptyCounts();
  for (const item of items) {
    counts[item.category] += 1;
  }

  const hasManualAction = items.some((item) => MANUAL_ACTION_CATEGORIES.has(item.category));

  return { items, counts, hasManualAction };
}

/**
 * Render a worktree recovery report as short diagnostic lines. Pure: returns
 * strings only and performs no side effects.
 */
export function formatWorktreeRecoveryReport(report: WorktreeRecoveryReport): string[] {
  const { items, counts, hasManualAction } = report;

  if (items.length === 0) {
    return ['Worktree recovery: no worktrees found for this run.'];
  }

  const lines: string[] = [];
  lines.push(
    `Worktree recovery: ${items.length} worktree(s) — keep:${counts.keep_for_resume} cleanup:${counts.cleanup_candidate} unknown:${counts.unknown_task} no-state:${counts.no_task_graph_state}`,
  );

  for (const item of items) {
    lines.push(
      `- [${item.category}] task=${item.taskId} branch=${item.branch} path=${item.worktreePath} — ${item.reason}`,
    );
  }

  if (hasManualAction) {
    lines.push(
      'Manual review required: one or more worktrees need a human decision before any cleanup. No worktrees are deleted automatically.',
    );
  }

  return lines;
}
