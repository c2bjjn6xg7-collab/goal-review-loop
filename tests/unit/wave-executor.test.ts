/**
 * Phase 8D P5 Round 2A unit tests for src/scheduler/wave-executor.ts.
 *
 * Covers:
 *   - invalid worker count rejection (before planning)
 *   - basic event ordering (plan-computed first, then per-wave/per-batch/per-task)
 *   - sequential wave gate (wave N+1 never overlaps wave N)
 *   - concurrency cap (no more than maxParallelWorkers run at once; later
 *     batches wait for earlier ones)
 *   - non-parallelizable tasks land in singleton waves and run alone
 *   - conflict demotion places conflicting tasks into separate waves
 *   - dependency validation runs over the post-demotion plan
 *   - thrown runner errors are converted to FAILED results with string messages
 *   - runner returning a mismatched taskId aborts with invalid-runner-result
 *   - onEvent callback observes the same events as the returned `events` array
 */
import { describe, it, expect } from 'vitest';
import {
  runWaveExecutorCore,
  WaveExecutorError,
  type WaveExecutorEvent,
  type WaveTaskRunner,
  type WaveTaskRunnerResult,
} from '../../src/scheduler/wave-executor.js';
import { TaskStatus, type TaskNode } from '../../src/types.js';

function makeTask(
  id: string,
  opts: {
    dependsOn?: string[];
    parallelizable?: boolean;
    allowedChanges?: string[];
  } = {},
): TaskNode {
  return {
    id,
    title: id,
    description: `${id} test`,
    difficulty: 'low',
    risk: 'low',
    parallelizable: opts.parallelizable ?? true,
    depends_on: opts.dependsOn ?? [],
    allowed_changes: opts.allowedChanges ?? [`src/${id}/**`],
    disallowed_changes: [],
    verification_commands: [
      { id: 'vc', command: ['true'], cwd: '.', required: true, timeout_seconds: 60 },
    ],
    status: 'pending',
  };
}

const passRunner: WaveTaskRunner = async (task) => ({
  taskId: task.id,
  status: TaskStatus.PASSED,
  error: null,
});

describe('runWaveExecutorCore', () => {
  describe('invalid worker count', () => {
    it('rejects non-integer worker count with code invalid-worker-count', async () => {
      const onEvent = (): void => {
        throw new Error('onEvent must not fire when worker count is invalid');
      };
      await expect(
        runWaveExecutorCore({
          tasks: [makeTask('t1')],
          trackedFiles: [],
          maxParallelWorkers: 1.5,
          runTask: passRunner,
          onEvent,
        }),
      ).rejects.toMatchObject({ name: 'WaveExecutorError', code: 'invalid-worker-count' });
    });

    it('rejects zero worker count with code invalid-worker-count', async () => {
      await expect(
        runWaveExecutorCore({
          tasks: [makeTask('t1')],
          trackedFiles: [],
          maxParallelWorkers: 0,
          runTask: passRunner,
        }),
      ).rejects.toBeInstanceOf(WaveExecutorError);
    });

    it('rejects negative worker count with code invalid-worker-count', async () => {
      await expect(
        runWaveExecutorCore({
          tasks: [makeTask('t1')],
          trackedFiles: [],
          maxParallelWorkers: -1,
          runTask: passRunner,
        }),
      ).rejects.toMatchObject({ code: 'invalid-worker-count' });
    });

    it('rejects NaN worker count with code invalid-worker-count', async () => {
      await expect(
        runWaveExecutorCore({
          tasks: [makeTask('t1')],
          trackedFiles: [],
          maxParallelWorkers: Number.NaN,
          runTask: passRunner,
        }),
      ).rejects.toMatchObject({ code: 'invalid-worker-count' });
    });
  });

  describe('event ordering', () => {
    it('emits plan-computed first, then wave/batch/task events in order', async () => {
      const tasks = [makeTask('t1'), makeTask('t2', { dependsOn: ['t1'] })];
      const observed: WaveExecutorEvent[] = [];
      const result = await runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 2,
        runTask: passRunner,
        onEvent: (e) => observed.push(e),
      });

      // First event is plan-computed; events array matches onEvent observations.
      expect(result.events[0]).toEqual({ type: 'plan-computed', plan: [['t1'], ['t2']] });
      expect(observed).toEqual(result.events);

      const types = result.events.map((e) => e.type);
      expect(types).toEqual([
        'plan-computed',
        'wave-start',
        'batch-start',
        'task-start',
        'task-finish',
        'batch-finish',
        'wave-finish',
        'wave-start',
        'batch-start',
        'task-start',
        'task-finish',
        'batch-finish',
        'wave-finish',
      ]);
    });

    it('returns plan, results in execution order, and a complete events list', async () => {
      const tasks = [makeTask('a'), makeTask('b'), makeTask('c', { dependsOn: ['a'] })];
      const result = await runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 4,
        runTask: passRunner,
      });

      expect(result.plan.waves).toEqual([['a', 'b'], ['c']]);
      expect(result.results.map((r) => r.taskId)).toEqual(['a', 'b', 'c']);
      expect(result.results.every((r) => r.status === TaskStatus.PASSED)).toBe(true);

      const planEvent = result.events.find((e) => e.type === 'plan-computed');
      expect(planEvent).toEqual({ type: 'plan-computed', plan: [['a', 'b'], ['c']] });
    });

    it('returns parallel batch results in actual finish order', async () => {
      const tasks = [makeTask('slow'), makeTask('fast')];
      const result = await runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 2,
        runTask: async (task) => {
          await new Promise((resolve) => setTimeout(resolve, task.id === 'slow' ? 25 : 1));
          return { taskId: task.id, status: TaskStatus.PASSED, error: null };
        },
      });

      expect(result.results.map((r) => r.taskId)).toEqual(['fast', 'slow']);
      const finishEvents = result.events
        .filter((e): e is Extract<WaveExecutorEvent, { type: 'task-finish' }> => e.type === 'task-finish')
        .map((e) => e.taskId);
      expect(finishEvents).toEqual(['fast', 'slow']);
    });
  });

  describe('wave gate (sequential waves)', () => {
    it('does not start wave N+1 until wave N has finished', async () => {
      const tasks = [
        makeTask('a'),
        makeTask('b'),
        makeTask('c', { dependsOn: ['a', 'b'] }),
      ];
      let releaseWave0: () => void = () => {};
      const wave0Gate = new Promise<void>((resolve) => {
        releaseWave0 = resolve;
      });
      const observedDuringWave0: string[] = [];

      const runTask: WaveTaskRunner = async (task) => {
        if (task.id === 'a' || task.id === 'b') {
          await wave0Gate;
        } else {
          // If wave 1 starts while wave 0 is gated, this push is a violation.
          observedDuringWave0.push(task.id);
        }
        return { taskId: task.id, status: TaskStatus.PASSED, error: null };
      };

      const runPromise = runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 2,
        runTask,
      });

      // Yield to give the executor a chance to (incorrectly) start wave 1.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(observedDuringWave0).toEqual([]);

      releaseWave0();
      const result = await runPromise;
      expect(result.results.map((r) => r.taskId)).toEqual(['a', 'b', 'c']);

      // Verify event ordering: wave 0 fully finishes before wave 1 starts.
      const types = result.events.map((e) => `${e.type}:${'waveIndex' in e ? e.waveIndex : ''}`);
      const wave0Finish = types.indexOf('wave-finish:0');
      const wave1Start = types.indexOf('wave-start:1');
      expect(wave0Finish).toBeGreaterThanOrEqual(0);
      expect(wave1Start).toBeGreaterThan(wave0Finish);
    });
  });

  describe('concurrency cap', () => {
    it('runs at most maxParallelWorkers tasks concurrently and batches the rest', async () => {
      const tasks = [
        makeTask('a'),
        makeTask('b'),
        makeTask('c'),
        makeTask('d'),
        makeTask('e'),
      ];
      let active = 0;
      let peak = 0;
      const releaseSignals: Array<() => void> = [];
      const startedIds: string[] = [];
      const runTask: WaveTaskRunner = async (task) => {
        active++;
        if (active > peak) peak = active;
        startedIds.push(task.id);
        await new Promise<void>((resolve) => {
          releaseSignals.push(resolve);
        });
        active--;
        return { taskId: task.id, status: TaskStatus.PASSED, error: null };
      };

      const runPromise = runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 2,
        runTask,
      });

      // Drain microtasks until two tasks are running.
      while (releaseSignals.length < 2) {
        await new Promise((r) => setImmediate(r));
      }
      expect(active).toBe(2);
      expect(startedIds).toEqual(['a', 'b']);

      // The third task must NOT have started yet — it's queued in the next batch.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(startedIds.length).toBe(2);

      // Release the first batch; the second batch should kick off.
      releaseSignals[0]();
      releaseSignals[1]();
      while (releaseSignals.length < 4) {
        await new Promise((r) => setImmediate(r));
      }
      expect(startedIds.slice(0, 4)).toEqual(['a', 'b', 'c', 'd']);
      releaseSignals[2]();
      releaseSignals[3]();
      while (releaseSignals.length < 5) {
        await new Promise((r) => setImmediate(r));
      }
      releaseSignals[4]();

      const result = await runPromise;
      expect(peak).toBeLessThanOrEqual(2);
      expect(result.results.map((r) => r.taskId).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);

      // Three batches of size 2,2,1 → three batch-start/finish event pairs.
      const batchStarts = result.events.filter((e) => e.type === 'batch-start');
      expect(batchStarts.length).toBe(3);
    });
  });

  describe('non-parallelizable singleton waves', () => {
    it('places non-parallelizable tasks in their own singleton wave', async () => {
      const tasks = [
        makeTask('p1', { parallelizable: true }),
        makeTask('p2', { parallelizable: true }),
        makeTask('np', { parallelizable: false }),
      ];
      const result = await runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 4,
        runTask: passRunner,
      });
      // computeWaves: at depth 0 the non-parallelizable task lands in its own
      // wave first, then the parallel wave follows.
      expect(result.plan.waves).toEqual([['np'], ['p1', 'p2']]);

      // Verify the singleton wave only ever has one running task.
      const singletonBatchStarts = result.events.filter(
        (e) => e.type === 'batch-start' && e.waveIndex === 0,
      );
      expect(singletonBatchStarts).toHaveLength(1);
      expect(singletonBatchStarts[0]).toMatchObject({ taskIds: ['np'] });
    });

    it('runs a non-parallelizable task alone even when more workers are available', async () => {
      const tasks = [
        makeTask('np', { parallelizable: false }),
        makeTask('p1'),
        makeTask('p2'),
      ];
      let active = 0;
      let peak = 0;
      const runTask: WaveTaskRunner = async (task) => {
        active++;
        if (active > peak) peak = active;
        await new Promise((r) => setImmediate(r));
        active--;
        return { taskId: task.id, status: TaskStatus.PASSED, error: null };
      };
      await runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 8,
        runTask,
      });
      // Across the run peak may reach 2 (the parallel wave), but the non-parallel
      // wave must never share a batch with another task.
      expect(peak).toBeLessThanOrEqual(2);
    });
  });

  describe('conflict demotion', () => {
    it('demotes conflicting parallel tasks into a later wave', async () => {
      // Two tasks scheduled in the same wave by computeWaves but their
      // allowed_changes overlap — detectWaveConflicts flags them and
      // demoteConflicts pushes the lexically larger id to a new wave.
      const tasks = [
        makeTask('a', { allowedChanges: ['src/shared/**'] }),
        makeTask('b', { allowedChanges: ['src/shared/**'] }),
      ];
      const result = await runWaveExecutorCore({
        tasks,
        trackedFiles: ['src/shared/x.ts'],
        maxParallelWorkers: 4,
        runTask: passRunner,
      });
      expect(result.plan.waves).toEqual([['a'], ['b']]);
      const planEvent = result.events.find((e) => e.type === 'plan-computed');
      expect(planEvent).toEqual({ type: 'plan-computed', plan: [['a'], ['b']] });
    });

    it('does not demote tasks whose allowed_changes do not overlap', async () => {
      const tasks = [
        makeTask('a', { allowedChanges: ['src/a/**'] }),
        makeTask('b', { allowedChanges: ['src/b/**'] }),
      ];
      const result = await runWaveExecutorCore({
        tasks,
        trackedFiles: ['src/a/x.ts', 'src/b/y.ts'],
        maxParallelWorkers: 4,
        runTask: passRunner,
      });
      expect(result.plan.waves).toEqual([['a', 'b']]);
    });
  });

  describe('dependency validation after demotion', () => {
    it('passes validation when the post-demotion plan still satisfies dependencies', async () => {
      // a conflicts with b → b is demoted into wave 1. c depends only on a
      // (wave 0), so landing it in wave 1 alongside b is still valid.
      const tasks = [
        makeTask('a', { allowedChanges: ['src/shared/**'] }),
        makeTask('b', { allowedChanges: ['src/shared/**'] }),
        makeTask('c', { dependsOn: ['a'], allowedChanges: ['src/c/**'] }),
      ];
      const result = await runWaveExecutorCore({
        tasks,
        trackedFiles: ['src/shared/x.ts'],
        maxParallelWorkers: 4,
        runTask: passRunner,
      });
      const aWave = result.plan.waveIndexOfTask.get('a')!;
      const bWave = result.plan.waveIndexOfTask.get('b')!;
      const cWave = result.plan.waveIndexOfTask.get('c')!;
      expect(aWave).toBe(0);
      expect(bWave).toBe(1);
      // c is at depth 1 and is parallelizable, so it shares wave 1 with the
      // demoted b. Validation must accept this because c does not depend on b.
      expect(cWave).toBe(1);
    });

    it('rejects with a wave-compute error when demotion would violate dependency order', async () => {
      // a and b conflict — demoting b pushes it into wave 1. c depends on b
      // but is also at depth 1 (depending on a). After demotion both b and c
      // land in wave 1, which violates the dep-before-dependent rule that
      // validateWaveDependencies enforces against the post-demotion plan.
      const tasks = [
        makeTask('a', { allowedChanges: ['src/shared/**'] }),
        makeTask('b', { allowedChanges: ['src/shared/**'] }),
        makeTask('c', { dependsOn: ['a', 'b'], allowedChanges: ['src/c/**'] }),
      ];
      await expect(
        runWaveExecutorCore({
          tasks,
          trackedFiles: ['src/shared/x.ts'],
          maxParallelWorkers: 4,
          runTask: passRunner,
        }),
      ).rejects.toMatchObject({
        name: 'WaveComputeError',
        code: 'dependency-order-violation',
      });
    });
  });

  describe('runner errors and invariants', () => {
    it('converts thrown runner Errors into FAILED results with string messages', async () => {
      const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
      const runTask: WaveTaskRunner = async (task) => {
        if (task.id === 'b') {
          throw new Error('boom for b');
        }
        return { taskId: task.id, status: TaskStatus.PASSED, error: null };
      };
      const result = await runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 4,
        runTask,
      });
      const byId = new Map(result.results.map((r) => [r.taskId, r]));
      expect(byId.get('a')?.status).toBe(TaskStatus.PASSED);
      expect(byId.get('c')?.status).toBe(TaskStatus.PASSED);
      expect(byId.get('b')).toEqual({
        taskId: 'b',
        status: TaskStatus.FAILED,
        error: 'boom for b',
      });

      // task-finish event for b reflects the failure.
      const finish = result.events.find(
        (e): e is Extract<WaveExecutorEvent, { type: 'task-finish' }> =>
          e.type === 'task-finish' && e.taskId === 'b',
      );
      expect(finish?.status).toBe(TaskStatus.FAILED);
      expect(finish?.error).toBe('boom for b');
    });

    it('stringifies non-Error throws into the FAILED error message', async () => {
      const tasks = [makeTask('a')];
      const runTask: WaveTaskRunner = async () => {
        throw 'plain string failure';
      };
      const result = await runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 1,
        runTask,
      });
      expect(result.results[0]).toEqual({
        taskId: 'a',
        status: TaskStatus.FAILED,
        error: 'plain string failure',
      });
    });

    it('rejects with invalid-runner-result when the runner returns a wrong taskId', async () => {
      const tasks = [makeTask('a')];
      const runTask: WaveTaskRunner = async (): Promise<WaveTaskRunnerResult> => ({
        taskId: 'not-a',
        status: TaskStatus.PASSED,
        error: null,
      });
      await expect(
        runWaveExecutorCore({
          tasks,
          trackedFiles: [],
          maxParallelWorkers: 1,
          runTask,
        }),
      ).rejects.toMatchObject({
        name: 'WaveExecutorError',
        code: 'invalid-runner-result',
      });
    });
  });

  describe('event behavior', () => {
    it('mirrors every emission to onEvent and the returned events array', async () => {
      const tasks = [makeTask('a'), makeTask('b', { dependsOn: ['a'] })];
      const observed: WaveExecutorEvent[] = [];
      const result = await runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 1,
        runTask: passRunner,
        onEvent: (e) => observed.push(e),
      });
      expect(observed).toEqual(result.events);
      // Each task contributes a task-start + task-finish.
      const taskStarts = result.events.filter((e) => e.type === 'task-start');
      const taskFinishes = result.events.filter((e) => e.type === 'task-finish');
      expect(taskStarts.map((e) => (e as { taskId: string }).taskId)).toEqual(['a', 'b']);
      expect(taskFinishes.map((e) => (e as { taskId: string }).taskId)).toEqual(['a', 'b']);
    });

    it('surfaces TaskRunnerContext fields in runner invocations', async () => {
      const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
      const seen: Array<{ id: string; waveIndex: number; batchIndex: number; idx: number; cap: number }> = [];
      const runTask: WaveTaskRunner = async (task, ctx) => {
        seen.push({
          id: task.id,
          waveIndex: ctx.waveIndex,
          batchIndex: ctx.batchIndex,
          idx: ctx.taskIndexInBatch,
          cap: ctx.maxParallelWorkers,
        });
        return { taskId: task.id, status: TaskStatus.PASSED, error: null };
      };
      await runWaveExecutorCore({
        tasks,
        trackedFiles: [],
        maxParallelWorkers: 2,
        runTask,
      });
      // 3 tasks, cap 2 → batch 0: [a,b]; batch 1: [c].
      expect(seen).toEqual([
        { id: 'a', waveIndex: 0, batchIndex: 0, idx: 0, cap: 2 },
        { id: 'b', waveIndex: 0, batchIndex: 0, idx: 1, cap: 2 },
        { id: 'c', waveIndex: 0, batchIndex: 1, idx: 0, cap: 2 },
      ]);
    });

    it('emits an empty plan and no wave events when given no tasks', async () => {
      const result = await runWaveExecutorCore({
        tasks: [],
        trackedFiles: [],
        maxParallelWorkers: 1,
        runTask: passRunner,
      });
      expect(result.plan.waves).toEqual([]);
      expect(result.results).toEqual([]);
      expect(result.events).toEqual([{ type: 'plan-computed', plan: [] }]);
    });
  });
});
