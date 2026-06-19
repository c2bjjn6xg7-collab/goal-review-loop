import { describe, expect, it } from 'vitest';
import {
  FailurePolicyError,
  recordFailureGuardFailure,
  recordFailureGuardPass,
  type FailureClass,
} from '../../src/scheduler/failure-policy.js';

describe('failure policy guard helpers', () => {
  it('resets any nonzero count on pass', () => {
    expect(recordFailureGuardPass({
      consecutiveFailureCount: 4,
      maxConsecutiveFailures: 5,
    })).toEqual({
      consecutiveFailureCount: 0,
      thresholdReached: false,
      errorCode: null,
      message: null,
    });
  });

  it('increments one tracked failure by exactly one', () => {
    const update = recordFailureGuardFailure({
      consecutiveFailureCount: 0,
      maxConsecutiveFailures: 3,
      failureClass: 'auditor_block',
    });

    expect(update.consecutiveFailureCount).toBe(1);
    expect(update.thresholdReached).toBe(false);
    expect(update.errorCode).toBeNull();
    expect(update.message).toBeNull();
  });

  it('does not reach the threshold before the configured limit', () => {
    const update = recordFailureGuardFailure({
      consecutiveFailureCount: 1,
      maxConsecutiveFailures: 3,
      failureClass: 'developer_blocked',
    });

    expect(update.consecutiveFailureCount).toBe(2);
    expect(update.thresholdReached).toBe(false);
  });

  it('reaches the threshold exactly at the configured limit', () => {
    const update = recordFailureGuardFailure({
      consecutiveFailureCount: 2,
      maxConsecutiveFailures: 3,
      failureClass: 'verification_failed',
    });

    expect(update.consecutiveFailureCount).toBe(3);
    expect(update.thresholdReached).toBe(true);
    expect(update.errorCode).toBe('CONSECUTIVE_FAILURE_LIMIT');
    expect(update.message).toContain('verification_failed');
    expect(update.message).toContain('3');
  });

  it('keeps the threshold reached above the configured limit', () => {
    const update = recordFailureGuardFailure({
      consecutiveFailureCount: 3,
      maxConsecutiveFailures: 3,
      failureClass: 'infrastructure_error',
    });

    expect(update.consecutiveFailureCount).toBe(4);
    expect(update.thresholdReached).toBe(true);
    expect(update.errorCode).toBe('CONSECUTIVE_FAILURE_LIMIT');
    expect(update.message).toContain('4/3');
  });

  it('accepts every tracked failure class', () => {
    const classes: FailureClass[] = [
      'auditor_block',
      'developer_blocked',
      'verification_failed',
      'infrastructure_error',
    ];

    for (const failureClass of classes) {
      expect(recordFailureGuardFailure({
        consecutiveFailureCount: 0,
        maxConsecutiveFailures: 2,
        failureClass,
      }).consecutiveFailureCount).toBe(1);
    }
  });

  it('includes failure class, new count, and threshold in threshold messages', () => {
    const update = recordFailureGuardFailure({
      consecutiveFailureCount: 2,
      maxConsecutiveFailures: 3,
      failureClass: 'auditor_block',
    });

    expect(update.message).toContain('auditor_block');
    expect(update.message).toContain('3/3');
  });

  it.each([
    [{ consecutiveFailureCount: -1, maxConsecutiveFailures: 3 }],
    [{ consecutiveFailureCount: 1.5, maxConsecutiveFailures: 3 }],
    [{ consecutiveFailureCount: 0, maxConsecutiveFailures: 0 }],
    [{ consecutiveFailureCount: 0, maxConsecutiveFailures: 1.5 }],
  ])('rejects invalid guard input %#', (input) => {
    expect(() => recordFailureGuardPass(input)).toThrow(FailurePolicyError);
  });

  it('rejects invalid failure class values defensively', () => {
    expect(() => recordFailureGuardFailure({
      consecutiveFailureCount: 0,
      maxConsecutiveFailures: 3,
      failureClass: 'unknown' as FailureClass,
    })).toThrow(FailurePolicyError);
  });

  it('does not mutate input objects', () => {
    const input = {
      consecutiveFailureCount: 2,
      maxConsecutiveFailures: 3,
      failureClass: 'developer_blocked' as FailureClass,
    };
    const before = { ...input };

    recordFailureGuardFailure(input);

    expect(input).toEqual(before);
  });
});
