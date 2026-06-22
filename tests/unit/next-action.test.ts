import { describe, it, expect } from 'vitest';
import { computeNextAction } from '../../src/runtime/next-action.js';

describe('computeNextAction', () => {
  describe('non-terminal phases', () => {
    it('INITIALIZING', () => {
      expect(computeNextAction('INITIALIZING', 0, 0)).toBe(
        'Run is initializing. Use `review-loop start` to begin.',
      );
    });

    it('PLANNING', () => {
      expect(computeNextAction('PLANNING', 0, 0)).toBe(
        'Planner is running. Wait for it to complete.',
      );
    });

    it('DEVELOPING interpolates iteration and max_iterations', () => {
      expect(computeNextAction('DEVELOPING', 2, 5)).toBe(
        'Developer is running (iteration 2/5). Wait for it to complete.',
      );
    });

    it('REWORKING interpolates iteration and max_iterations', () => {
      expect(computeNextAction('REWORKING', 3, 4)).toBe(
        'Rework is in progress (iteration 3/4). Wait for it to complete.',
      );
    });

    it('VERIFYING interpolates iteration and max_iterations', () => {
      expect(computeNextAction('VERIFYING', 1, 3)).toBe(
        'Verification is running (iteration 1/3). Wait for it to complete.',
      );
    });

    it('AUDITING interpolates iteration and max_iterations', () => {
      expect(computeNextAction('AUDITING', 2, 6)).toBe(
        'Auditor is running (iteration 2/6). Wait for it to complete.',
      );
    });

    it('FINALIZING', () => {
      expect(computeNextAction('FINALIZING', 0, 0)).toBe(
        '正在等待或执行最终审计/本地提交',
      );
    });
  });

  describe('terminal phases', () => {
    it('PASSED', () => {
      expect(computeNextAction('PASSED', 1, 3)).toBe(
        'Run completed successfully. Final Audit passed and code committed.',
      );
    });

    it('FAILED interpolates iteration', () => {
      expect(computeNextAction('FAILED', 4, 5)).toBe(
        'Run failed after 4 iteration(s). Review errors and adjust configuration.',
      );
    });

    it('BLOCKED', () => {
      expect(computeNextAction('BLOCKED', 0, 0)).toBe(
        'Run is blocked. Resolve the blocking issue and use `review-loop resume`.',
      );
    });

    it('CANCELLED', () => {
      expect(computeNextAction('CANCELLED', 0, 0)).toBe('Run was cancelled.');
    });
  });

  it('unknown phase returns "Unknown phase."', () => {
    expect(computeNextAction('NOT_A_PHASE', 1, 2)).toBe('Unknown phase.');
  });
});
