/**
 * Phase 8D P5 Round 1 unit tests for src/scheduler/wave-compute.ts.
 *
 * Covers:
 *   - 3-task diamond / two roots + one dep
 *   - 3-task chain
 *   - cycle throws
 *   - missing dependency throws
 *   - non-parallelizable task occupies its own wave
 *   - two non-parallelizable tasks in the same layer ordered by id
 *   - empty input
 *   - basic demotion
 *   - cascading demotion
 *   - no-conflict identity behavior
 *   - demotion cap throws on pathological input
 */
import { describe, it, expect } from 'vitest';
import {
  computeWaves,
  demoteConflicts,
  validateWaveDependencies,
  WaveComputeError,
  type WavePlan,
} from '../../src/scheduler/wave-compute.js';
import type { TaskNode } from '../../src/types.js';

function makeTask(
  id: string,
  opts: { dependsOn?: string[]; parallelizable?: boolean } = {},
): TaskNode {
  return {
    id,
    title: id,
    description: `${id} test`,
    difficulty: 'low',
    risk: 'low',
    parallelizable: opts.parallelizable ?? true,
    depends_on: opts.dependsOn ?? [],
    allowed_changes: ['src/x/**'],
    disallowed_changes: [],
    verification_commands: [
      { id: 'vc', command: ['true'], cwd: '.', required: true, timeout_seconds: 60 },
    ],
    status: 'pending',
  };
}

describe('computeWaves', () => {
  it('two roots + one dep: wave [t1,t2] then [t3]', () => {
    const tasks = [
      makeTask('t1'),
      makeTask('t2'),
      makeTask('t3', { dependsOn: ['t1'] }),
    ];
    const plan = computeWaves(tasks);
    expect(plan.waves).toEqual([
      ['t1', 't2'],
      ['t3'],
    ]);
    expect(plan.waveIndexOfTask.get('t1')).toBe(0);
    expect(plan.waveIndexOfTask.get('t2')).toBe(0);
    expect(plan.waveIndexOfTask.get('t3')).toBe(1);
  });

  it('diamond t1 → {t2, t3} → t4 produces three waves', () => {
    const tasks = [
      makeTask('t1'),
      makeTask('t2', { dependsOn: ['t1'] }),
      makeTask('t3', { dependsOn: ['t1'] }),
      makeTask('t4', { dependsOn: ['t2', 't3'] }),
    ];
    const plan = computeWaves(tasks);
    expect(plan.waves).toEqual([
      ['t1'],
      ['t2', 't3'],
      ['t4'],
    ]);
  });

  it('chain t1 → t2 → t3 produces three waves of one', () => {
    const tasks = [
      makeTask('t1'),
      makeTask('t2', { dependsOn: ['t1'] }),
      makeTask('t3', { dependsOn: ['t2'] }),
    ];
    expect(computeWaves(tasks).waves).toEqual([['t1'], ['t2'], ['t3']]);
  });

  it('throws WaveComputeError on cycle t1 ↔ t2', () => {
    const tasks = [
      makeTask('t1', { dependsOn: ['t2'] }),
      makeTask('t2', { dependsOn: ['t1'] }),
    ];
    let caught: unknown = null;
    try {
      computeWaves(tasks);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WaveComputeError);
    expect((caught as WaveComputeError).code).toBe('cycle');
    expect((caught as WaveComputeError).message).toMatch(/cycle/i);
  });

  it('throws WaveComputeError on missing dependency', () => {
    const tasks = [makeTask('t2', { dependsOn: ['ghost'] })];
    let caught: unknown = null;
    try {
      computeWaves(tasks);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WaveComputeError);
    expect((caught as WaveComputeError).code).toBe('missing-dependency');
    expect((caught as WaveComputeError).message).toMatch(/ghost|missing/i);
  });

  it('non-parallelizable task occupies its wave alone (parallel task shifts)', () => {
    const tasks = [
      makeTask('t1', { parallelizable: false }),
      makeTask('t2', { parallelizable: true }),
    ];
    // t1 (np) singleton at wave 0; t2 (parallel) shifted to wave 1 — never
    // mixed into the np singleton wave.
    expect(computeWaves(tasks).waves).toEqual([['t1'], ['t2']]);
  });

  it('two non-parallelizable tasks in the same layer occupy consecutive singleton waves ordered by id', () => {
    const tasks = [
      makeTask('tB', { parallelizable: false }),
      makeTask('tA', { parallelizable: false }),
    ];
    // Lexical order tA before tB; both are np singletons.
    expect(computeWaves(tasks).waves).toEqual([['tA'], ['tB']]);
  });

  it('mixed layer: two np singletons followed by a parallel wave', () => {
    const tasks = [
      makeTask('tB', { parallelizable: false }),
      makeTask('tA', { parallelizable: false }),
      makeTask('tC', { parallelizable: true }),
      makeTask('tD', { parallelizable: true }),
    ];
    const plan = computeWaves(tasks);
    expect(plan.waves).toEqual([
      ['tA'],
      ['tB'],
      ['tC', 'tD'],
    ]);
  });

  it('empty input returns empty waves and empty index without throwing', () => {
    const plan = computeWaves([]);
    expect(plan.waves).toEqual([]);
    expect(plan.waveIndexOfTask.size).toBe(0);
  });
});

describe('demoteConflicts', () => {
  it('demotes the lexically larger task id on conflict', () => {
    const plan: WavePlan = {
      waves: [['auth', 'login']],
      waveIndexOfTask: new Map([
        ['auth', 0],
        ['login', 0],
      ]),
    };
    const conflicts = new Map([
      ['auth', ['login']],
      ['login', ['auth']],
    ]);
    const out = demoteConflicts(plan, conflicts);
    expect(out.waves[0]).toEqual(['auth']);
    expect(out.waves[1]).toEqual(['login']);
    expect(out.waveIndexOfTask.get('auth')).toBe(0);
    expect(out.waveIndexOfTask.get('login')).toBe(1);
  });

  it('cascades: a demoted task conflicts in the next wave and is demoted again', () => {
    // Wave 0: [a, b], Wave 1: [c]. Conflicts: a↔b, b↔c.
    // Step 1: in wave 0, demote `b` (lexically larger of the {a,b} pair).
    // Step 2: wave 1 becomes [b, c]. b and c conflict → demote `c`.
    // Final waves: [[a], [b], [c]].
    const plan: WavePlan = {
      waves: [['a', 'b'], ['c']],
      waveIndexOfTask: new Map([
        ['a', 0],
        ['b', 0],
        ['c', 1],
      ]),
    };
    const conflicts = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a', 'c']],
      ['c', ['b']],
    ]);
    const out = demoteConflicts(plan, conflicts);
    expect(out.waves).toEqual([['a'], ['b'], ['c']]);
    expect(out.waveIndexOfTask.get('a')).toBe(0);
    expect(out.waveIndexOfTask.get('b')).toBe(1);
    expect(out.waveIndexOfTask.get('c')).toBe(2);
  });

  it('no conflicts → waves unchanged and index rebuilt', () => {
    const plan: WavePlan = {
      waves: [['a', 'b']],
      waveIndexOfTask: new Map([
        ['a', 0],
        ['b', 0],
      ]),
    };
    const out = demoteConflicts(plan, new Map());
    expect(out.waves).toEqual([['a', 'b']]);
    expect(out.waveIndexOfTask.get('a')).toBe(0);
    expect(out.waveIndexOfTask.get('b')).toBe(0);
  });

  it('empty conflicts adjacency for a peer is treated as no conflict', () => {
    const plan: WavePlan = {
      waves: [['x', 'y', 'z']],
      waveIndexOfTask: new Map([
        ['x', 0],
        ['y', 0],
        ['z', 0],
      ]),
    };
    const conflicts = new Map<string, string[]>([
      ['x', []],
      ['y', []],
      ['z', []],
    ]);
    const out = demoteConflicts(plan, conflicts);
    expect(out.waves).toEqual([['x', 'y', 'z']]);
  });

  it('does not mutate the input plan', () => {
    const inputWaves = [['auth', 'login']];
    const plan: WavePlan = {
      waves: inputWaves,
      waveIndexOfTask: new Map([
        ['auth', 0],
        ['login', 0],
      ]),
    };
    const conflicts = new Map([
      ['auth', ['login']],
      ['login', ['auth']],
    ]);
    demoteConflicts(plan, conflicts);
    expect(plan.waves).toEqual([['auth', 'login']]);
    expect(inputWaves).toEqual([['auth', 'login']]);
  });

  it('validates dependency order when tasks are supplied', () => {
    const tasks = [
      makeTask('a'),
      makeTask('b'),
      makeTask('c', { dependsOn: ['b'] }),
    ];
    const plan: WavePlan = {
      waves: [['a', 'b'], ['c']],
      waveIndexOfTask: new Map([
        ['a', 0],
        ['b', 0],
        ['c', 1],
      ]),
    };
    const conflicts = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    expect(() => demoteConflicts(plan, conflicts, tasks)).toThrow(/depends on "b"/);
  });
});

describe('validateWaveDependencies', () => {
  it('accepts a valid computed wave plan', () => {
    const tasks = [
      makeTask('root'),
      makeTask('child', { dependsOn: ['root'] }),
    ];
    expect(() => validateWaveDependencies(computeWaves(tasks), tasks)).not.toThrow();
  });

  it('throws when a dependency is in the same wave as its dependent', () => {
    const tasks = [
      makeTask('dep'),
      makeTask('child', { dependsOn: ['dep'] }),
    ];
    const invalidPlan: WavePlan = {
      waves: [['dep', 'child']],
      waveIndexOfTask: new Map([
        ['dep', 0],
        ['child', 0],
      ]),
    };
    let caught: unknown = null;
    try {
      validateWaveDependencies(invalidPlan, tasks);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WaveComputeError);
    expect((caught as WaveComputeError).code).toBe('dependency-order-violation');
  });
});
