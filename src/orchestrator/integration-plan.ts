import { orderedTasks } from '../scheduler/task-graph.js';
import { readTaskRunResult } from '../scheduler/task-run-result.js';
import type { TaskGraph } from '../types.js';

export interface IntegrationTaskEntry {
  task_id: string;
  branch: string;
  commit_sha: string;
  status: 'passed';
}

export interface ExcludedIntegrationTask {
  task_id: string;
  reason: string;
  status:
    | 'missing'
    | 'invalid'
    | 'failed'
    | 'blocked'
    | 'passed_without_commit'
    | 'dependency_excluded';
}

export interface IntegrationPlan {
  schema_version: 1;
  run_id: string;
  base_commit: string;
  integration_branch: string;
  tasks: IntegrationTaskEntry[];
  excluded_tasks: ExcludedIntegrationTask[];
  partial: boolean;
  created_at: string;
}

export async function buildIntegrationPlan(params: {
  projectRoot: string;
  runId: string;
  baseCommit: string;
  taskGraph: TaskGraph;
}): Promise<IntegrationPlan> {
  const ordered = orderedTasks(params.taskGraph);
  const excludedByTaskId = new Map<string, ExcludedIntegrationTask>();
  const selected: IntegrationTaskEntry[] = [];

  for (const task of ordered) {
    const excludedDependencies = task.depends_on.filter((dependencyId) =>
      excludedByTaskId.has(dependencyId),
    );
    if (excludedDependencies.length > 0) {
      const excluded = {
        task_id: task.id,
        status: 'dependency_excluded' as const,
        reason: `Excluded because dependent task(s) were excluded: ${excludedDependencies.join(', ')}`,
      };
      excludedByTaskId.set(task.id, excluded);
      continue;
    }

    const outcome = await readTaskRunResult(params.projectRoot, params.runId, task.id);
    if (!outcome.found) {
      const excluded = outcome.error
        ? {
            task_id: task.id,
            status: 'invalid' as const,
            reason: `Task-run result is invalid: ${outcome.error.message}`,
          }
        : {
            task_id: task.id,
            status: 'missing' as const,
            reason: 'Task-run result is missing',
          };
      excludedByTaskId.set(task.id, excluded);
      continue;
    }

    const result = outcome.result;
    if (result.status === 'failed') {
      const excluded = {
        task_id: task.id,
        status: 'failed' as const,
        reason: result.error ? `Task failed: ${result.error}` : 'Task status is failed',
      };
      excludedByTaskId.set(task.id, excluded);
      continue;
    }

    if (result.status === 'blocked') {
      const excluded = {
        task_id: task.id,
        status: 'blocked' as const,
        reason: result.error ? `Task blocked: ${result.error}` : 'Task status is blocked',
      };
      excludedByTaskId.set(task.id, excluded);
      continue;
    }

    if (!result.final_commit_sha || !result.branch) {
      const missing = [
        result.final_commit_sha ? null : 'final_commit_sha',
        result.branch ? null : 'branch',
      ].filter((value): value is string => value !== null);
      const excluded = {
        task_id: task.id,
        status: 'passed_without_commit' as const,
        reason: `Task passed without required integration field(s): ${missing.join(', ')}`,
      };
      excludedByTaskId.set(task.id, excluded);
      continue;
    }

    selected.push({
      task_id: task.id,
      branch: result.branch,
      commit_sha: result.final_commit_sha,
      status: 'passed',
    });
  }

  const excludedTasks = Array.from(excludedByTaskId.values());
  return {
    schema_version: 1,
    run_id: params.runId,
    base_commit: params.baseCommit,
    integration_branch: `integration/${params.runId}`,
    tasks: selected,
    excluded_tasks: excludedTasks,
    partial: excludedTasks.length > 0,
    created_at: new Date().toISOString(),
  };
}
