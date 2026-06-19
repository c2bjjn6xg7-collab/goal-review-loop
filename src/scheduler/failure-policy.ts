/**
 * Phase 8D P6: pure failure-policy helpers.
 *
 * This module intentionally does not read or write runtime state. Orchestrator
 * wiring in later P6 rounds will use these helpers to update state.json.
 */

export type FailureClass =
  | 'auditor_block'
  | 'developer_blocked'
  | 'verification_failed'
  | 'infrastructure_error';

export interface FailureGuardInput {
  consecutiveFailureCount: number;
  maxConsecutiveFailures: number;
}

export interface FailureGuardFailureInput extends FailureGuardInput {
  failureClass: FailureClass;
}

export interface FailureGuardUpdate {
  consecutiveFailureCount: number;
  thresholdReached: boolean;
  errorCode: 'CONSECUTIVE_FAILURE_LIMIT' | null;
  message: string | null;
}

export class FailurePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailurePolicyError';
  }
}

export function recordFailureGuardPass(input: FailureGuardInput): FailureGuardUpdate {
  validateFailureGuardInput(input);
  return {
    consecutiveFailureCount: 0,
    thresholdReached: false,
    errorCode: null,
    message: null,
  };
}

export function recordFailureGuardFailure(input: FailureGuardFailureInput): FailureGuardUpdate {
  validateFailureGuardInput(input);
  if (!isFailureClass(input.failureClass)) {
    throw new FailurePolicyError(`Invalid failureClass: ${String(input.failureClass)}`);
  }

  const nextCount = input.consecutiveFailureCount + 1;
  const thresholdReached = nextCount >= input.maxConsecutiveFailures;

  return {
    consecutiveFailureCount: nextCount,
    thresholdReached,
    errorCode: thresholdReached ? 'CONSECUTIVE_FAILURE_LIMIT' : null,
    message: thresholdReached
      ? `Consecutive failure limit reached: ${input.failureClass} raised count ${nextCount}/${input.maxConsecutiveFailures}`
      : null,
  };
}

function validateFailureGuardInput(input: FailureGuardInput): void {
  if (!Number.isInteger(input.consecutiveFailureCount) || input.consecutiveFailureCount < 0) {
    throw new FailurePolicyError('consecutiveFailureCount must be an integer >= 0');
  }
  if (!Number.isInteger(input.maxConsecutiveFailures) || input.maxConsecutiveFailures < 1) {
    throw new FailurePolicyError('maxConsecutiveFailures must be an integer >= 1');
  }
}

function isFailureClass(value: unknown): value is FailureClass {
  return value === 'auditor_block'
    || value === 'developer_blocked'
    || value === 'verification_failed'
    || value === 'infrastructure_error';
}
