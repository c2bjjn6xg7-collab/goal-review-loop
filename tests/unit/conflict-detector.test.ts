import { describe, it, expect } from 'vitest';
import { globsMayConflict, detectWaveConflicts } from '../../src/scheduler/conflict-detector.js';
import {
  TaskDifficulty,
  TaskRisk,
  TaskStatus,
  type TaskNode,
} from '../../src/types.js';

function makeTask(id: string, allowed: string[]): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    difficulty: TaskDifficulty.LOW,
    risk: TaskRisk.LOW,
    parallelizable: true,
    depends_on: [],
    allowed_changes: allowed,
    disallowed_changes: [],
    verification_commands: [],
    status: TaskStatus.PENDING,
  };
}

describe('globsMayConflict', () => {
  it('returns true for src/auth/** vs src/auth/login.ts (prefix overlap, tracked sample)', () => {
    expect(globsMayConflict('src/auth/**', 'src/auth/login.ts', ['src/auth/login.ts'])).toBe(true);
  });

  it('returns true for src/auth/** vs src/auth/login.ts even with no tracked samples (conservative)', () => {
    expect(globsMayConflict('src/auth/**', 'src/auth/login.ts', [])).toBe(true);
  });

  it('returns false for disjoint prefixes src/auth/** vs src/core/**', () => {
    expect(
      globsMayConflict('src/auth/**', 'src/core/**', ['src/auth/login.ts', 'src/core/index.ts']),
    ).toBe(false);
  });

  it('returns true for *.ts vs src/foo.ts (uncertain root-level glob)', () => {
    // Conservative: `*.ts` has empty literal prefix, must not be ruled out.
    expect(globsMayConflict('*.ts', 'src/foo.ts', ['src/foo.ts', 'README.md'])).toBe(true);
  });

  it('returns true for src/**/test.ts vs src/a/test.ts (shared prefix, sample matches both)', () => {
    expect(globsMayConflict('src/**/test.ts', 'src/a/test.ts', ['src/a/test.ts'])).toBe(true);
  });

  it('returns false for package.json vs src/** (disjoint literal vs subtree)', () => {
    expect(
      globsMayConflict('package.json', 'src/**', ['package.json', 'src/index.ts']),
    ).toBe(false);
  });

  it('is symmetric in argument order for the documented cases', () => {
    expect(globsMayConflict('src/auth/login.ts', 'src/auth/**', ['src/auth/login.ts'])).toBe(true);
    expect(globsMayConflict('src/core/**', 'src/auth/**', [])).toBe(false);
    expect(globsMayConflict('src/foo.ts', '*.ts', ['src/foo.ts'])).toBe(true);
    expect(globsMayConflict('src/**', 'package.json', ['package.json', 'src/index.ts'])).toBe(false);
  });
});

describe('detectWaveConflicts', () => {
  it('returns a symmetric map for overlapping tasks', () => {
    const tasks: TaskNode[] = [
      makeTask('t1', ['src/auth/**']),
      makeTask('t2', ['src/auth/login.ts']),
    ];
    const trackedFiles = ['src/auth/login.ts'];

    const result = detectWaveConflicts(tasks, trackedFiles);

    expect(result.get('t1')).toEqual(['t2']);
    expect(result.get('t2')).toEqual(['t1']);
  });

  it('returns empty conflict lists for tasks with disjoint scopes', () => {
    const tasks: TaskNode[] = [
      makeTask('t1', ['src/auth/**']),
      makeTask('t2', ['src/core/**']),
    ];
    const trackedFiles = ['src/auth/login.ts', 'src/core/index.ts'];

    const result = detectWaveConflicts(tasks, trackedFiles);

    expect(result.get('t1')).toEqual([]);
    expect(result.get('t2')).toEqual([]);
  });

  it('never marks a task as conflicting with itself', () => {
    const tasks: TaskNode[] = [
      makeTask('t1', ['src/auth/**', 'src/auth/login.ts']),
      makeTask('t2', ['src/auth/**']),
      makeTask('t3', ['src/core/**']),
    ];
    const trackedFiles = ['src/auth/login.ts', 'src/core/index.ts'];

    const result = detectWaveConflicts(tasks, trackedFiles);

    for (const [taskId, conflicts] of result.entries()) {
      expect(conflicts).not.toContain(taskId);
    }
  });

  it('contains exactly the tasks supplied as keys (no extras, none missing)', () => {
    const tasks: TaskNode[] = [
      makeTask('alpha', ['src/auth/**']),
      makeTask('beta', ['src/core/**']),
      makeTask('gamma', ['docs/**']),
    ];

    const result = detectWaveConflicts(tasks, []);

    expect([...result.keys()].sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('produces a symmetric multi-task conflict map with no duplicates', () => {
    const tasks: TaskNode[] = [
      makeTask('t1', ['src/auth/**']),
      makeTask('t2', ['src/auth/login.ts']),
      makeTask('t3', ['src/auth/session.ts']),
      makeTask('t4', ['src/core/**']),
    ];
    const trackedFiles = ['src/auth/login.ts', 'src/auth/session.ts', 'src/core/index.ts'];

    const result = detectWaveConflicts(tasks, trackedFiles);

    // t1 (src/auth/**) overlaps with t2 and t3 but not t4.
    expect(new Set(result.get('t1'))).toEqual(new Set(['t2', 't3']));
    // t2 conflicts only with t1 (different specific files don't overlap with t3).
    expect(result.get('t2')).toEqual(['t1']);
    expect(result.get('t3')).toEqual(['t1']);
    expect(result.get('t4')).toEqual([]);

    // Symmetric verification: every edge appears in both directions.
    for (const [taskId, conflicts] of result.entries()) {
      for (const other of conflicts) {
        expect(result.get(other)).toContain(taskId);
      }
    }

    // No duplicates per list.
    for (const conflicts of result.values()) {
      expect(conflicts.length).toBe(new Set(conflicts).size);
    }
  });

  it('returns disjoint results for tasks with multiple allowed_changes when none overlap', () => {
    const tasks: TaskNode[] = [
      makeTask('t1', ['src/auth/**', 'docs/auth.md']),
      makeTask('t2', ['src/core/**', 'docs/core.md']),
    ];
    const trackedFiles = ['src/auth/login.ts', 'src/core/index.ts', 'docs/auth.md', 'docs/core.md'];

    const result = detectWaveConflicts(tasks, trackedFiles);

    expect(result.get('t1')).toEqual([]);
    expect(result.get('t2')).toEqual([]);
  });

  it('flags conflict when any single allowed_changes pair overlaps across tasks', () => {
    const tasks: TaskNode[] = [
      makeTask('t1', ['src/auth/**', 'docs/auth.md']),
      makeTask('t2', ['src/core/**', 'docs/auth.md']),
    ];
    const trackedFiles = ['src/auth/login.ts', 'src/core/index.ts', 'docs/auth.md'];

    const result = detectWaveConflicts(tasks, trackedFiles);

    expect(result.get('t1')).toEqual(['t2']);
    expect(result.get('t2')).toEqual(['t1']);
  });

  it('handles an empty task list without error', () => {
    const result = detectWaveConflicts([], ['src/anything.ts']);
    expect(result.size).toBe(0);
  });
});
