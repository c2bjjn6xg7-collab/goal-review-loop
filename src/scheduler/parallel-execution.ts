import type { ReviewLoopConfig } from '../types.js';

/**
 * Phase 8D P5 Round 2B: pure parallel-execution decision resolver.
 *
 * Decides whether a single review-loop run should use the existing serial
 * orchestrator path or be treated as a wave-mode (parallel) request. This
 * module is intentionally pure: it does not import filesystem, process, git,
 * agent, or orchestrator state. The resolver is the single source of truth
 * for combining `ReviewLoopConfig.parallel` with optional CLI overrides.
 *
 * Wave-mode here is a *request signal*. Round 2B does not run worktrees or
 * parallel agents; the orchestrator uses this signal to fail closed until
 * Round 2C wires real worktree-backed wave execution.
 */

export type ParallelExecutionMode = 'serial' | 'wave';
export type ParallelExecutionSource = 'default' | 'config' | 'cli';

/**
 * Optional CLI overrides accepted by the resolver. `parallel: true` is the
 * explicit CLI opt-in; `maxParallelWorkers` is a numeric override that on its
 * own does NOT enable parallelism.
 */
export interface ParallelCliOverrides {
  parallel?: boolean;
  maxParallelWorkers?: number;
}

/**
 * Resolved decision the orchestrator acts on. `mode === 'wave'` means a
 * caller explicitly opted in and requested more than one worker; `mode ===
 * 'serial'` covers both the disabled default and the explicit-but-narrow
 * "parallel with one worker" case.
 */
export interface ParallelExecutionDecision {
  enabled: boolean;
  mode: ParallelExecutionMode;
  maxParallelWorkers: number;
  source: ParallelExecutionSource;
  reason: string;
}

/**
 * Thrown when configured or CLI worker counts fall outside the [1, 16]
 * integer range. Callers (CLI, orchestrator) are expected to surface this as
 * a clear configuration error rather than crashing.
 */
export class ParallelExecutionConfigError extends Error {
  public readonly code: 'invalid-worker-count';

  constructor(message: string) {
    super(message);
    this.name = 'ParallelExecutionConfigError';
    this.code = 'invalid-worker-count';
  }
}

/**
 * Resolve the parallel execution decision from `ReviewLoopConfig.parallel`
 * and optional CLI overrides.
 *
 * Rules:
 * - A worker count alone never enables parallelism. Either
 *   `config.parallel.enabled === true` or `overrides.parallel === true` is
 *   required for explicit opt-in.
 * - When neither side opts in, the decision is disabled serial with one
 *   worker, regardless of any configured `max_parallel_workers`.
 * - When opt-in is present but the resolved worker count is 1, the decision
 *   is `serial` (explicit opt-in honored, but no real parallelism).
 * - When opt-in is present and the resolved worker count is greater than 1,
 *   the decision is `wave`.
 * - Both configured and CLI worker counts are validated as integers in the
 *   inclusive range [1, 16]; invalid values throw
 *   `ParallelExecutionConfigError`.
 */
export function resolveParallelExecution(
  config: Pick<ReviewLoopConfig, 'parallel'>,
  overrides: ParallelCliOverrides = {},
): ParallelExecutionDecision {
  const configParallel = config.parallel;
  const cliHasWorkerOverride = overrides.maxParallelWorkers !== undefined;
  const cliRequested = overrides.parallel === true;
  const configRequested = configParallel?.enabled === true;
  const requested = cliRequested || configRequested;

  const source: ParallelExecutionSource =
    cliRequested || cliHasWorkerOverride
      ? 'cli'
      : configParallel
        ? 'config'
        : 'default';

  const configuredWorkers = configParallel?.max_parallel_workers ?? 1;
  validateWorkerCount(configuredWorkers, 'config.parallel.max_parallel_workers');

  if (cliHasWorkerOverride) {
    validateWorkerCount(overrides.maxParallelWorkers!, '--max-parallel-workers');
  }

  const requestedWorkers = overrides.maxParallelWorkers ?? configuredWorkers;

  if (!requested) {
    return {
      enabled: false,
      mode: 'serial',
      maxParallelWorkers: 1,
      source,
      reason: 'parallel execution disabled',
    };
  }

  if (requestedWorkers <= 1) {
    return {
      enabled: true,
      mode: 'serial',
      maxParallelWorkers: 1,
      source,
      reason: 'parallel requested but maxParallelWorkers is 1',
    };
  }

  return {
    enabled: true,
    mode: 'wave',
    maxParallelWorkers: requestedWorkers,
    source,
    reason: 'parallel wave execution requested',
  };
}

function validateWorkerCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new ParallelExecutionConfigError(
      `${label} must be an integer from 1 to 16, got ${value}`,
    );
  }
}
