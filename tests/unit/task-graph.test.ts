/**
 * Unit tests for src/scheduler/task-graph.ts — Phase 8B.
 */
import { describe, it, expect } from 'vitest';
import {
  validateTaskGraph,
  topologicalSort,
  orderedTasks,
  initialTaskStatuses,
  initialTaskAttempts,
} from '../../src/scheduler/task-graph.js';
import type { TaskGraph } from '../../src/types.js';

function makeTask(overrides: Partial<TaskGraph['tasks'][number]> = {}): TaskGraph['tasks'][number] {
  return {
    id: 'task-1',
    title: 'Task 1',
    description: 'Does task 1',
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

function makeGraph(tasks: TaskGraph['tasks'][number]): TaskGraph;
function makeGraph(tasks: TaskGraph['tasks'][number][]): TaskGraph;
function makeGraph(tasks: TaskGraph['tasks'][number][] | TaskGraph['tasks'][number]): TaskGraph {
  const arr = Array.isArray(tasks) ? tasks : [tasks];
  return {
    schema_version: 1,
    run_id: 'run-001',
    goal_digest: 'sha256:abc123def456abc123def456abc123def456abc123def456abc123def456ab12',
    tasks: arr,
    created_at: '2026-06-17T00:00:00Z',
  };
}

describe('task-graph validation', () => {
  it('accepts a valid minimal graph', () => {
    const g = makeGraph(makeTask());
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.graph).not.toBeNull();
  });

  it('accepts a valid multi-task DAG', () => {
    const g = makeGraph([
      makeTask({ id: 't1', allowed_changes: ['src/a/**'] }),
      makeTask({ id: 't2', depends_on: ['t1'], allowed_changes: ['src/b/**'] }),
      makeTask({ id: 't3', depends_on: ['t1', 't2'], allowed_changes: ['src/c/**'] }),
    ]);
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(true);
  });

  it('rejects a cycle', () => {
    const g = makeGraph([
      makeTask({ id: 't1', depends_on: ['t2'] }),
      makeTask({ id: 't2', depends_on: ['t1'] }),
    ]);
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('cycle'))).toBe(true);
  });

  it('rejects missing dependency reference', () => {
    const g = makeGraph([
      makeTask({ id: 't1', depends_on: ['ghost'] }),
    ]);
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('ghost'))).toBe(true);
  });

  it('rejects empty allowed_changes', () => {
    const g = makeGraph([
      makeTask({ id: 't1', allowed_changes: [] }),
    ]);
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(false);
  });

  it('rejects task with no verification_commands', () => {
    const g = makeGraph([
      makeTask({ id: 't1', verification_commands: [] }),
    ]);
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(false);
  });

  it('rejects duplicate task ids', () => {
    const g = makeGraph([
      makeTask({ id: 't1' }),
      makeTask({ id: 't1', allowed_changes: ['src/b/**'] }),
    ]);
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });

  it('rejects self-dependency', () => {
    const g = makeGraph([
      makeTask({ id: 't1', depends_on: ['t1'] }),
    ]);
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('itself'))).toBe(true);
  });

  it('rejects unsafe allowed_changes paths (absolute)', () => {
    const g = makeGraph([
      makeTask({ id: 't1', allowed_changes: ['/etc/**'] }),
    ]);
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(false);
  });

  it('rejects unsafe allowed_changes paths (..)', () => {
    const g = makeGraph([
      makeTask({ id: 't1', allowed_changes: ['../escape/**'] }),
    ]);
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(false);
  });

  it('rejects more than 10 tasks', () => {
    const tasks = Array.from({ length: 11 }, (_, i) =>
      makeTask({ id: `t${i}`, allowed_changes: [`src/m${i}/**`] }),
    );
    const r = validateTaskGraph(makeGraph(tasks));
    expect(r.valid).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    const g = makeGraph(makeTask());
    (g as unknown as { schema_version: number }).schema_version = 2;
    const r = validateTaskGraph(g);
    expect(r.valid).toBe(false);
  });

  it('rejects non-object input', () => {
    const r = validateTaskGraph('not a graph');
    expect(r.valid).toBe(false);
  });
});

describe('topologicalSort', () => {
  it('returns ids in dependency order for a chain', () => {
    const g = makeGraph([
      makeTask({ id: 't1' }),
      makeTask({ id: 't2', depends_on: ['t1'] }),
      makeTask({ id: 't3', depends_on: ['t2'] }),
    ]);
    const order = topologicalSort(g);
    expect(order).toEqual(['t1', 't2', 't3']);
  });

  it('returns null for a cycle', () => {
    const g = makeGraph([
      makeTask({ id: 't1', depends_on: ['t2'] }),
      makeTask({ id: 't2', depends_on: ['t1'] }),
    ]);
    expect(topologicalSort(g)).toBeNull();
  });

  it('handles independent tasks deterministically', () => {
    const g = makeGraph([
      makeTask({ id: 'a', allowed_changes: ['src/a/**'] }),
      makeTask({ id: 'b', allowed_changes: ['src/b/**'] }),
      makeTask({ id: 'c', allowed_changes: ['src/c/**'] }),
    ]);
    const order = topologicalSort(g);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('orderedTasks', () => {
  it('returns TaskNode objects in topological order', () => {
    const g = makeGraph([
      makeTask({ id: 't1', title: 'First' }),
      makeTask({ id: 't2', title: 'Second', depends_on: ['t1'] }),
    ]);
    const ordered = orderedTasks(g);
    expect(ordered.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(ordered[0].title).toBe('First');
  });

  it('throws on cycle', () => {
    const g = makeGraph([
      makeTask({ id: 't1', depends_on: ['t2'] }),
      makeTask({ id: 't2', depends_on: ['t1'] }),
    ]);
    expect(() => orderedTasks(g)).toThrow(/cycle/i);
  });
});

describe('initialTaskStatuses / initialTaskAttempts', () => {
  it('initializes all tasks to pending', () => {
    const g = makeGraph([
      makeTask({ id: 't1' }),
      makeTask({ id: 't2', allowed_changes: ['src/b/**'] }),
    ]);
    const statuses = initialTaskStatuses(g);
    expect(statuses).toEqual({ t1: 'pending', t2: 'pending' });
  });

  it('initializes all task attempts to 0', () => {
    const g = makeGraph([
      makeTask({ id: 't1' }),
      makeTask({ id: 't2', allowed_changes: ['src/b/**'] }),
    ]);
    const attempts = initialTaskAttempts(g);
    expect(attempts).toEqual({ t1: 0, t2: 0 });
  });
});
