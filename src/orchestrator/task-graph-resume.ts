/**
 * Task-Graph Resume Decision — Phase 8D P7.
 *
 * Status-driven resume index selector for task-graph runs. Centralizes the
 * decision of which task a resumed run should restart at so the orchestrator
 * no longer trusts raw `current_task_index` blindly. Per-task statuses are
 * more precise than the saved index when a run was interrupted or BLOCKED.
 *
 * Selection order:
 *   1. earliest task with status `failed | running | blocked`
 *   2. earliest task with status `pending`
 *   3. `all_tasks_complete` (taskIndex = ordered.length, so the existing
 *      task loop is skipped and integration verification/finalization runs)
 *
 * This helper is pure: it never mutates the supplied graph or state and does
 * not touch the filesystem.
 */

import { orderedTasks } from '../scheduler/task-graph.js';
import type { TaskGraph, TaskGraphState } from '../types.js';

export interface TaskGraphResumeDecision {
  /** `resume_task` to restart at `taskIndex`; `all_tasks_complete` to skip the task loop. */
  kind: 'resume_task' | 'all_tasks_complete';
  /** Index into `orderedTasks(taskGraph)` to resume at. For `all_tasks_complete` this is `ordered.length`. */
  taskIndex: number;
  /** The task id at `taskIndex`, or null when `all_tasks_complete`. */
  taskId: string | null;
  /** Human-readable reason for the decision (also used for orchestrator logging). */
  reason: string;
}

const RESUME_STATUSES = new Set(['failed', 'running', 'blocked']);

/**
 * Resolve which task a resumed task-graph run should restart at.
 */
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
      reason: 'Task graph has no tasks — nothing to execute.',
    };
  }

  if (!taskGraphState) {
    const first = ordered[0];
    return {
      kind: 'resume_task',
      taskIndex: 0,
      taskId: first.id,
      reason: `No task_graph_state; starting at first task (${first.id}).`,
    };
  }

  const statuses = taskGraphState.task_statuses ?? {};

  // 1. Earliest failed / running / blocked task.
  for (let i = 0; i < ordered.length; i++) {
    const task = ordered[i];
    if (RESUME_STATUSES.has(statuses[task.id] ?? '')) {
      return {
        kind: 'resume_task',
        taskIndex: i,
        taskId: task.id,
        reason: `Resuming task ${task.id} (status: ${statuses[task.id]}).`,
      };
    }
  }

  // 2. Earliest pending task.
  for (let i = 0; i < ordered.length; i++) {
    const task = ordered[i];
    if ((statuses[task.id] ?? '') === 'pending') {
      return {
        kind: 'resume_task',
        taskIndex: i,
        taskId: task.id,
        reason: `Resuming at next pending task (${task.id}).`,
      };
    }
  }

  // 3. Everything passed/skipped (or unrecognized) — skip the task loop.
  return {
    kind: 'all_tasks_complete',
    taskIndex: ordered.length,
    taskId: null,
    reason: `All ${ordered.length} task(s) complete — skipping to integration verification/finalization.`,
  };
}
