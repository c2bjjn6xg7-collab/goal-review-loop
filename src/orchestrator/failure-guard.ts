/**
 * Phase 8D P6 Round 2: orchestrator-layer failure guard.
 *
 * Thin wrapper around the Round 1 pure helpers (src/scheduler/failure-policy.ts).
 * Reads state, computes the next count via the pure function, persists via
 * StateStore.update. This module has side effects (state.json writes) and lives
 * in orchestrator/, distinct from the pure scheduler/ helper.
 *
 * Responsibility boundary:
 *   - Does: read count, compute next, persist, return outcome.
 *   - Does NOT: transition phase, build OrchestratorResult, write iteration-log,
 *     or catch exceptions. FailurePolicyError from the pure layer is re-thrown
 *     unchanged so callers see invalid-config / invalid-state as hard failures.
 *
 * The early-exit decision is NOT made here. `thresholdReached` in the returned
 * outcome is for logging and test observability only. The actual FAILED
 * transition happens at the single loop-top gate in runIterationLoop.
 */

import type { StateStore } from './state-store.js';
import type { ReviewLoopConfig } from '../types.js';
import {
  recordFailureGuardFailure,
  recordFailureGuardPass,
  type FailureClass,
} from '../scheduler/failure-policy.js';

export interface FailureGuardOutcome {
  /** New count after this update, persisted to state.json. */
  consecutiveFailureCount: number;
  /** True iff THIS update reached the threshold.
   *  Observability only — the early-exit gate lives at the loop top. */
  thresholdReached: boolean;
}

/**
 * Record a tracked soft-failure. Increments the run-level counter and persists
 * it. The caller continues to the next iteration; the loop-top gate performs
 * the FAILED transition when the threshold has been reached.
 *
 * Does not catch exceptions. `FailurePolicyError` (invalid count / invalid
 * threshold / invalid failureClass) propagates to the caller.
 */
export async function recordSoftFailure(
  stateStore: StateStore,
  config: ReviewLoopConfig,
  failureClass: FailureClass,
): Promise<FailureGuardOutcome> {
  const current = await stateStore.read();
  const pure = recordFailureGuardFailure({
    consecutiveFailureCount: current.consecutive_failure_count,
    maxConsecutiveFailures: config.loop.max_consecutive_failures,
    failureClass,
  });
  await stateStore.update(() => ({
    consecutive_failure_count: pure.consecutiveFailureCount,
  }));
  return {
    consecutiveFailureCount: pure.consecutiveFailureCount,
    thresholdReached: pure.thresholdReached,
  };
}

/**
 * Reset the run-level counter on a passing iteration (Auditor PASS entering
 * FINALIZING). Always writes 0 — no read-then-skip optimization; the extra
 * state.json write is trivial and the simpler logic is preferable.
 *
 * Does not catch exceptions.
 */
export async function recordSoftFailurePass(
  stateStore: StateStore,
  config: ReviewLoopConfig,
): Promise<FailureGuardOutcome> {
  const current = await stateStore.read();
  const pure = recordFailureGuardPass({
    consecutiveFailureCount: current.consecutive_failure_count,
    maxConsecutiveFailures: config.loop.max_consecutive_failures,
  });
  await stateStore.update(() => ({
    consecutive_failure_count: pure.consecutiveFailureCount,
  }));
  return {
    consecutiveFailureCount: pure.consecutiveFailureCount,
    thresholdReached: pure.thresholdReached,
  };
}
