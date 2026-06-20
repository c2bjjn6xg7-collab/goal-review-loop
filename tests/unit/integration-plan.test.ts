import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildIntegrationPlan } from '../../src/orchestrator/integration-plan.js';
import { taskRunResultPath, writeTaskRunResult, type TaskRunResult } from '../../src/scheduler/task-run-result.js';
import { TaskStatus, type TaskGraph, type TaskNode } from '../../src/types.js';

const RUN_ID = 'run-plan';
const BASE_COMMIT = '0123456789012345678901234567890123456789';

function makeProjectRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'integration-plan-'));
}

function makeTask(overrides: Partial<TaskNode> = {}): TaskNode {
  const id = overrides.id ?? 'task-1';
  return {
    id,
    title: `Task ${id}`,
    description: `Does ${id}`,
    difficulty: 'low',
    risk: 'low',
    parallelizable: true,
    depends_on: [],
    allowed_changes: [`src/${id}/**`],
    disallowed_changes: ['.git/**'],
    verification_commands: [
      { id: `${id}-verify`, command: ['node', '-e', 'process.exit(0)'], cwd: '.', required: true, timeout_seconds: 30 },
    ],
    status: TaskStatus.PENDING,
    ...overrides,
  };
}

function makeGraph(tasks: TaskNode[]): TaskGraph {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    goal_digest: 'sha256:abc',
    tasks,
    created_at: '2026-06-20T00:00:00.000Z',
  };
}

function makeResult(taskId: string, overrides: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    task_id: taskId,
    status: 'passed',
    exit_code: 0,
    final_commit_sha: `${taskId.padEnd(40, '0').slice(0, 40)}`,
    diff_digest: 'sha256:should-not-enter-integration-plan',
    branch: `agent/${RUN_ID}/${taskId}`,
    error: null,
    finished_at: '2026-06-20T00:01:00.000Z',
    ...overrides,
  };
}

describe('buildIntegrationPlan', () => {
  it('selects passed task-run results in DAG order', async () => {
    const projectRoot = makeProjectRoot();
    const graph = makeGraph([
      makeTask({ id: 'task-2', depends_on: ['task-1'] }),
      makeTask({ id: 'task-1' }),
    ]);
    await writeTaskRunResult(projectRoot, makeResult('task-1', { final_commit_sha: '1'.repeat(40) }));
    await writeTaskRunResult(projectRoot, makeResult('task-2', { final_commit_sha: '2'.repeat(40) }));

    const plan = await buildIntegrationPlan({ projectRoot, runId: RUN_ID, baseCommit: BASE_COMMIT, taskGraph: graph });

    expect(plan.schema_version).toBe(1);
    expect(plan.run_id).toBe(RUN_ID);
    expect(plan.base_commit).toBe(BASE_COMMIT);
    expect(plan.integration_branch).toBe(`integration/${RUN_ID}`);
    expect(plan.tasks.map((task) => task.task_id)).toEqual(['task-1', 'task-2']);
    expect(plan.excluded_tasks).toEqual([]);
    expect(plan.partial).toBe(false);
    expect(plan.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('excludes missing, failed, blocked, invalid, and passed-without-commit results', async () => {
    const projectRoot = makeProjectRoot();
    const graph = makeGraph([
      makeTask({ id: 'missing-task' }),
      makeTask({ id: 'failed-task' }),
      makeTask({ id: 'blocked-task' }),
      makeTask({ id: 'invalid-task' }),
      makeTask({ id: 'passed-without-commit' }),
      makeTask({ id: 'passed-without-branch' }),
      makeTask({ id: 'good-task' }),
    ]);
    await writeTaskRunResult(projectRoot, makeResult('failed-task', { status: 'failed', exit_code: 1, final_commit_sha: null, error: 'tests failed' }));
    await writeTaskRunResult(projectRoot, makeResult('blocked-task', { status: 'blocked', exit_code: null, final_commit_sha: null, error: 'needs scope' }));
    await fs.outputFile(taskRunResultPath(projectRoot, 'invalid-task'), '{not-json');
    await writeTaskRunResult(projectRoot, makeResult('passed-without-commit', { final_commit_sha: null }));
    await writeTaskRunResult(projectRoot, makeResult('passed-without-branch', { branch: null }));
    await writeTaskRunResult(projectRoot, makeResult('good-task', { final_commit_sha: 'a'.repeat(40) }));

    const plan = await buildIntegrationPlan({ projectRoot, runId: RUN_ID, baseCommit: BASE_COMMIT, taskGraph: graph });

    expect(plan.tasks.map((task) => task.task_id)).toEqual(['good-task']);
    expect(plan.excluded_tasks.map((task) => [task.task_id, task.status])).toEqual([
      ['missing-task', 'missing'],
      ['failed-task', 'failed'],
      ['blocked-task', 'blocked'],
      ['invalid-task', 'invalid'],
      ['passed-without-commit', 'passed_without_commit'],
      ['passed-without-branch', 'passed_without_commit'],
    ]);
    expect(plan.partial).toBe(true);
    expect(plan.excluded_tasks.map((task) => task.reason).every((reason) => reason.length > 0)).toBe(true);
  });

  it('excludes passed dependents transitively when a dependency is excluded', async () => {
    const projectRoot = makeProjectRoot();
    const graph = makeGraph([
      makeTask({ id: 'base' }),
      makeTask({ id: 'middle', depends_on: ['base'] }),
      makeTask({ id: 'leaf', depends_on: ['middle'] }),
    ]);
    await writeTaskRunResult(projectRoot, makeResult('base', { status: 'failed', exit_code: 1, final_commit_sha: null, error: 'base failed' }));
    await writeTaskRunResult(projectRoot, makeResult('middle', { final_commit_sha: 'b'.repeat(40) }));
    await writeTaskRunResult(projectRoot, makeResult('leaf', { final_commit_sha: 'c'.repeat(40) }));

    const plan = await buildIntegrationPlan({ projectRoot, runId: RUN_ID, baseCommit: BASE_COMMIT, taskGraph: graph });

    expect(plan.tasks).toEqual([]);
    expect(plan.excluded_tasks.map((task) => [task.task_id, task.status])).toEqual([
      ['base', 'failed'],
      ['middle', 'dependency_excluded'],
      ['leaf', 'dependency_excluded'],
    ]);
    expect(plan.excluded_tasks[1].reason).toContain('base');
    expect(plan.excluded_tasks[2].reason).toContain('middle');
  });

  it('does not copy per-task diff_digest into integration plan evidence', async () => {
    const projectRoot = makeProjectRoot();
    const graph = makeGraph([makeTask({ id: 'task-1' })]);
    await writeTaskRunResult(projectRoot, makeResult('task-1', {
      final_commit_sha: 'd'.repeat(40),
      diff_digest: 'sha256:very-visible-per-task-digest',
    }));

    const plan = await buildIntegrationPlan({ projectRoot, runId: RUN_ID, baseCommit: BASE_COMMIT, taskGraph: graph });

    expect(JSON.stringify(plan)).not.toContain('diff_digest');
    expect(JSON.stringify(plan)).not.toContain('very-visible-per-task-digest');
  });
});
