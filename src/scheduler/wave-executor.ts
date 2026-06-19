/**
 * Phase 8D P5 Round 2A: Pure wave executor core.
 *
 * `runWaveExecutorCore` accepts a `TaskNode[]`, the project's `trackedFiles`,
 * a `maxParallelWorkers` cap, and a `runTask` callback. It computes a wave
 * plan (via Round 1 primitives), executes tasks wave-by-wave with bounded
 * parallelism, and emits a deterministic event stream.
 *
 * This module is intentionally scheduler-only: it does not import filesystem,
 * process, git, agent, orchestrator, state-store, prompt, or worktree
 * modules. Real worktree execution and orchestrator wiring are owned by
 * later rounds (2B/P6/P7/P8).
 */
import { TaskStatus, type TaskNode } from '../types.js';
import { detectWaveConflicts } from './conflict-detector.js';
import {
  computeWaves,
  demoteConflicts,
  validateWaveDependencies,
  type WavePlan,
} from './wave-compute.js';

/**
 * Terminal task statuses observable by the wave executor. Tasks must finish
 * in one of these states; intermediate states like `RUNNING` are not exposed
 * as runner results.
 */
export type WaveTerminalTaskStatus =
  | typeof TaskStatus.PASSED
  | typeof TaskStatus.FAILED
  | typeof TaskStatus.BLOCKED;

/**
 * Context passed to a `WaveTaskRunner` so it can locate itself within the
 * computed plan.
 */
export interface WaveTaskRunnerContext {
  waveIndex: number;
  batchIndex: number;
  taskIndexInBatch: number;
  maxParallelWorkers: number;
}

/**
 * Result returned from a `WaveTaskRunner`. The `taskId` must match the task
 * that was passed in; mismatches are treated as a programmer error and
 * abort the executor with `WaveExecutorError('invalid-runner-result')`.
 */
export interface WaveTaskRunnerResult {
  taskId: string;
  status: WaveTerminalTaskStatus;
  error: string | null;
}

/**
 * Callback that executes a single task. The executor itself is pure; all
 * side-effectful work (worktrees, agents, verification) lives in the runner.
 */
export type WaveTaskRunner = (
  task: TaskNode,
  context: WaveTaskRunnerContext,
) => Promise<WaveTaskRunnerResult>;

/**
 * Events emitted as the executor walks the plan. These are recorded in the
 * returned `events` array and also forwarded to `onEvent` if provided. The
 * shape and order are part of the public contract.
 */
export type WaveExecutorEvent =
  | { type: 'plan-computed'; plan: string[][] }
  | { type: 'wave-start'; waveIndex: number; taskIds: string[] }
  | { type: 'batch-start'; waveIndex: number; batchIndex: number; taskIds: string[] }
  | { type: 'task-start'; waveIndex: number; batchIndex: number; taskId: string }
  | {
      type: 'task-finish';
      waveIndex: number;
      batchIndex: number;
      taskId: string;
      status: WaveTerminalTaskStatus;
      error: string | null;
    }
  | { type: 'batch-finish'; waveIndex: number; batchIndex: number; taskIds: string[] }
  | { type: 'wave-finish'; waveIndex: number; taskIds: string[] };

/**
 * Inputs for `runWaveExecutorCore`.
 */
export interface RunWaveExecutorParams {
  tasks: TaskNode[];
  trackedFiles: string[];
  maxParallelWorkers: number;
  runTask: WaveTaskRunner;
  onEvent?: (event: WaveExecutorEvent) => void;
}

/**
 * Result returned from `runWaveExecutorCore`.
 */
export interface WaveExecutorResult {
  plan: WavePlan;
  results: WaveTaskRunnerResult[];
  events: WaveExecutorEvent[];
}

/**
 * Error thrown for executor-level invariant violations:
 * - `invalid-worker-count`: `maxParallelWorkers` was not an integer `>= 1`.
 * - `invalid-runner-result`: `runTask` returned a result whose `taskId` did
 *   not match the task it was invoked for, or the wave plan referenced a
 *   task id that is not in the input list.
 *
 * Errors thrown *by* `runTask` are NOT surfaced via this class; they are
 * converted to a `{ status: FAILED, error: message }` result so the wave
 * can continue.
 */
export class WaveExecutorError extends Error {
  public readonly code: 'invalid-worker-count' | 'invalid-runner-result';

  constructor(
    message: string,
    code: 'invalid-worker-count' | 'invalid-runner-result',
  ) {
    super(message);
    this.name = 'WaveExecutorError';
    this.code = code;
  }
}

/**
 * Compute a wave plan and execute it sequentially by wave, with each wave
 * split into batches of at most `maxParallelWorkers` tasks executed
 * concurrently via `Promise.all`.
 *
 * Plan computation order is fixed:
 *   1. `computeWaves(tasks)`
 *   2. `detectWaveConflicts(tasks, trackedFiles)`
 *   3. `demoteConflicts(plan, conflicts, tasks)`
 *   4. `validateWaveDependencies(plan, tasks)`
 *
 * Only after the final validated plan exists is `plan-computed` emitted.
 */
export async function runWaveExecutorCore(
  params: RunWaveExecutorParams,
): Promise<WaveExecutorResult> {
  if (!Number.isInteger(params.maxParallelWorkers) || params.maxParallelWorkers < 1) {
    throw new WaveExecutorError(
      `maxParallelWorkers must be a positive integer, got ${params.maxParallelWorkers}`,
      'invalid-worker-count',
    );
  }

  const events: WaveExecutorEvent[] = [];
  const emit = (event: WaveExecutorEvent): void => {
    events.push(event);
    params.onEvent?.(event);
  };

  // Plan computation — order is part of the public contract.
  let plan = computeWaves(params.tasks);
  const conflicts = detectWaveConflicts(params.tasks, params.trackedFiles);
  plan = demoteConflicts(plan, conflicts, params.tasks);
  validateWaveDependencies(plan, params.tasks);
  emit({ type: 'plan-computed', plan: plan.waves.map((wave) => [...wave]) });

  const byId = new Map(params.tasks.map((task) => [task.id, task]));
  const results: WaveTaskRunnerResult[] = [];

  // Run a single task; convert thrown errors to failed results, but let
  // executor-level invariant violations (e.g. wrong taskId) propagate.
  const runOneTaskSafely = async (
    task: TaskNode,
    context: WaveTaskRunnerContext,
  ): Promise<WaveTaskRunnerResult> => {
    let result: WaveTaskRunnerResult;
    try {
      result = await params.runTask(task, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { taskId: task.id, status: TaskStatus.FAILED, error: message };
    }
    if (result.taskId !== task.id) {
      throw new WaveExecutorError(
        `runTask returned taskId "${result.taskId}" for task "${task.id}"`,
        'invalid-runner-result',
      );
    }
    return result;
  };

  for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex++) {
    const wave = plan.waves[waveIndex];
    emit({ type: 'wave-start', waveIndex, taskIds: [...wave] });

    for (
      let batchStart = 0, batchIndex = 0;
      batchStart < wave.length;
      batchStart += params.maxParallelWorkers, batchIndex++
    ) {
      const batch = wave.slice(batchStart, batchStart + params.maxParallelWorkers);
      emit({ type: 'batch-start', waveIndex, batchIndex, taskIds: [...batch] });

      await Promise.all(
        batch.map(async (taskId, taskIndexInBatch) => {
          const task = byId.get(taskId);
          if (!task) {
            throw new WaveExecutorError(
              `Wave plan referenced unknown task "${taskId}"`,
              'invalid-runner-result',
            );
          }
          emit({ type: 'task-start', waveIndex, batchIndex, taskId });
          const result = await runOneTaskSafely(task, {
            waveIndex,
            batchIndex,
            taskIndexInBatch,
            maxParallelWorkers: params.maxParallelWorkers,
          });
          emit({
            type: 'task-finish',
            waveIndex,
            batchIndex,
            taskId,
            status: result.status,
            error: result.error,
          });
          results.push(result);
          return result;
        }),
      );

      emit({ type: 'batch-finish', waveIndex, batchIndex, taskIds: [...batch] });
    }

    emit({ type: 'wave-finish', waveIndex, taskIds: [...wave] });
  }

  return { plan, results, events };
}
