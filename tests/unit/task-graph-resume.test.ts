/**
 * Unit tests for src/orchestrator/task-graph-resume.ts — Phase 8D P7.
 *
 * `resolveTaskGraphResumeDecision()` is the status-driven resume index
 * selector. It chooses the earliest failed/running/blocked task, then the
 * earliest pending task, otherwise declares `all_tasks_complete`. It never
 * mutates the supplied graph or state and does not touch the filesystem.
 */

import { describe, it, expect } from 'vitest';
import { resolveTaskGraphResumeDecision } from '../../src/orchestrator/task-graph-resume.js';
import type { TaskGraph, TaskGraphState, TaskStatus } from '../../src/types.js';

function makeTask(id: string, overrides: Partial<TaskGraph['tasks'][number]> = {}): TaskGraph['tasks'][number] {
  return {
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
    ...overrides,
  };
}

function makeGraph(tasks: TaskGraph['tasks'][number][]): TaskGraph {
  return {
    schema_version: 1,
    run_id: 'run-001',
    goal_digest: 'sha256:abc123def456abc123def456abc123def456abc123def456abc123def456ab12',
    tasks,
    created_at: '2026-06-17T00:00:00Z',
  };
}

function makeState(overrides: Partial<TaskGraphState> = {}): TaskGraphState {
  return {
    current_task_index: 0,
    task_statuses: {},
    task_attempts: {},
    ...overrides,
  };
}

function statuses(map: Record<string, TaskStatus>): Record<string, TaskStatus> {
  return map;
}

describe('resolveTaskGraphResumeDecision — ordering and selection', () => {
  it('restarts the earliest failed task even when current_task_index points later', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2'), makeTask('task-3')]);
    const state = makeState({
      current_task_index: 2,
      task_statuses: statuses({ 'task-1': 'passed', 'task-2': 'failed', 'task-3': 'pending' }),
      task_attempts: { 'task-1': 1, 'task-2': 1, 'task-3': 0 },
    });

    const decision = resolveTaskGraphResumeDecision(graph, state);

    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(1);
    expect(decision.taskId).toBe('task-2');
    expect(decision.reason).toBeTruthy();
  });

  it('restarts an interrupted running task', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2')]);
    const state = makeState({
      current_task_index: 1,
      task_statuses: statuses({ 'task-1': 'passed', 'task-2': 'running' }),
      task_attempts: { 'task-1': 1, 'task-2': 1 },
    });

    const decision = resolveTaskGraphResumeDecision(graph, state);

    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(1);
    expect(decision.taskId).toBe('task-2');
  });

  it('resumes a blocked task', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2')]);
    const state = makeState({
      current_task_index: 1,
      task_statuses: statuses({ 'task-1': 'passed', 'task-2': 'blocked' }),
      task_attempts: { 'task-1': 1, 'task-2': 1 },
    });

    const decision = resolveTaskGraphResumeDecision(graph, state);

    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(1);
    expect(decision.taskId).toBe('task-2');
  });

  it('prefers failed/running/blocked over pending when both exist', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2'), makeTask('task-3')]);
    const state = makeState({
      current_task_index: 0,
      task_statuses: statuses({ 'task-1': 'passed', 'task-2': 'pending', 'task-3': 'failed' }),
      task_attempts: { 'task-1': 1, 'task-2': 0, 'task-3': 1 },
    });

    const decision = resolveTaskGraphResumeDecision(graph, state);

    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(2);
    expect(decision.taskId).toBe('task-3');
  });

  it('continues at the earliest pending task when nothing failed/running/blocked', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2'), makeTask('task-3')]);
    const state = makeState({
      current_task_index: 0,
      task_statuses: statuses({ 'task-1': 'passed', 'task-2': 'passed', 'task-3': 'pending' }),
      task_attempts: { 'task-1': 1, 'task-2': 1, 'task-3': 0 },
    });

    const decision = resolveTaskGraphResumeDecision(graph, state);

    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(2);
    expect(decision.taskId).toBe('task-3');
  });

  it('picks the earliest pending task, not the latest', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2'), makeTask('task-3')]);
    const state = makeState({
      current_task_index: 0,
      task_statuses: statuses({ 'task-1': 'pending', 'task-2': 'pending', 'task-3': 'pending' }),
      task_attempts: { 'task-1': 0, 'task-2': 0, 'task-3': 0 },
    });

    const decision = resolveTaskGraphResumeDecision(graph, state);

    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(0);
    expect(decision.taskId).toBe('task-1');
  });
});

describe('resolveTaskGraphResumeDecision — completion and edges', () => {
  it('declares all_tasks_complete when every task passed or skipped', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2')]);
    const state = makeState({
      current_task_index: 2,
      task_statuses: statuses({ 'task-1': 'passed', 'task-2': 'skipped' }),
      task_attempts: { 'task-1': 1, 'task-2': 0 },
    });

    const decision = resolveTaskGraphResumeDecision(graph, state);

    expect(decision.kind).toBe('all_tasks_complete');
    expect(decision.taskIndex).toBe(2);
    expect(decision.taskId).toBeNull();
  });

  it('sets taskIndex to ordered length for all_tasks_complete (skips the task loop)', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2'), makeTask('task-3')]);
    const state = makeState({
      current_task_index: 3,
      task_statuses: statuses({ 'task-1': 'passed', 'task-2': 'passed', 'task-3': 'passed' }),
      task_attempts: { 'task-1': 1, 'task-2': 1, 'task-3': 1 },
    });

    const decision = resolveTaskGraphResumeDecision(graph, state);

    expect(decision.kind).toBe('all_tasks_complete');
    expect(decision.taskIndex).toBe(3);
  });

  it('returns all_tasks_complete for an empty graph', () => {
    const graph = makeGraph([]);
    const decision = resolveTaskGraphResumeDecision(graph, makeState());

    expect(decision.kind).toBe('all_tasks_complete');
    expect(decision.taskIndex).toBe(0);
    expect(decision.taskId).toBeNull();
  });

  it('starts at the first task when state is missing', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2')]);

    const decision = resolveTaskGraphResumeDecision(graph, null);

    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(0);
    expect(decision.taskId).toBe('task-1');
    expect(decision.reason).toMatch(/task_graph_state/i);
  });

  it('starts at the first task when state is undefined', () => {
    const graph = makeGraph([makeTask('task-1')]);

    const decision = resolveTaskGraphResumeDecision(graph, undefined);

    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(0);
    expect(decision.taskId).toBe('task-1');
  });

  it('treats a status map referencing unknown tasks defensively (falls through to pending scan)', () => {
    const graph = makeGraph([makeTask('task-1')]);
    const state = makeState({
      current_task_index: 0,
      task_statuses: statuses({ 'task-1': 'passed' }),
      task_attempts: {},
    });

    const decision = resolveTaskGraphResumeDecision(graph, state);

    expect(decision.kind).toBe('all_tasks_complete');
    expect(decision.taskIndex).toBe(1);
  });
});

describe('resolveTaskGraphResumeDecision — purity', () => {
  it('does not mutate the supplied state', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2')]);
    const state = makeState({
      current_task_index: 1,
      task_statuses: statuses({ 'task-1': 'failed', 'task-2': 'pending' }),
      task_attempts: { 'task-1': 1, 'task-2': 0 },
    });
    const snapshot = JSON.stringify(state);

    resolveTaskGraphResumeDecision(graph, state);

    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('does not mutate the supplied graph', () => {
    const graph = makeGraph([makeTask('task-1'), makeTask('task-2')]);
    const state = makeState({
      current_task_index: 0,
      task_statuses: statuses({ 'task-1': 'failed', 'task-2': 'pending' }),
      task_attempts: { 'task-1': 1, 'task-2': 0 },
    });
    const snapshot = JSON.stringify(graph);

    resolveTaskGraphResumeDecision(graph, state);

    expect(JSON.stringify(graph)).toBe(snapshot);
  });

  it('uses orderedTasks() (respects topological order, not graph array order)', () => {
    // task-2 depends on task-1, so topological order is [task-1, task-2]
    // even though the graph array lists task-2 first.
    const graph = makeGraph([
      makeTask('task-2', { depends_on: ['task-1'] }),
      makeTask('task-1'),
    ]);
    const state = makeState({
      current_task_index: 0,
      task_statuses: statuses({ 'task-1': 'passed', 'task-2': 'pending' }),
      task_attempts: { 'task-1': 1, 'task-2': 0 },
    });

    const decision = resolveTaskGraphResumeDecision(graph, state);

    expect(decision.kind).toBe('resume_task');
    expect(decision.taskIndex).toBe(1);
    expect(decision.taskId).toBe('task-2');
  });
});
