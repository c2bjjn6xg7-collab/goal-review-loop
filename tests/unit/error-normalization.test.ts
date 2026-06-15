/**
 * Unit tests for error normalization.
 * Phase 4 §8: 11 error codes → correct default phase, all required fields.
 */

import { describe, it, expect } from 'vitest';
import { ErrorCategory, ERROR_CATEGORY_DEFAULT_RESULT } from '../../src/types.js';
import type { ReviewLoopError } from '../../src/types.js';

describe('Error normalization', () => {
  const allCategories = Object.values(ErrorCategory);

  it('has exactly 21 error categories', () => {
    expect(allCategories).toHaveLength(21);
  });

  it('every error category has a default result phase', () => {
    for (const category of allCategories) {
      expect(ERROR_CATEGORY_DEFAULT_RESULT.has(category)).toBe(true);
    }
  });

  it('ReviewLoopError has all required fields', () => {
    const error: ReviewLoopError = {
      code: 'CONFIG_ERROR',
      message: 'Test error',
      resumable: false,
      suggested_action: 'Check configuration',
    };

    expect(error.code).toBeTruthy();
    expect(error.message).toBeTruthy();
    expect(typeof error.resumable).toBe('boolean');
    expect(error.suggested_action).toBeTruthy();
  });

  it('ReviewLoopError supports optional Phase 4 fields', () => {
    const error: ReviewLoopError = {
      code: 'VERIFICATION_FAILED',
      message: 'Tests failed',
      phase: 'VERIFYING',
      iteration: 2,
      retryable: true,
      resumable: true,
      evidence_paths: ['.agent/verification/manifest.json'],
      suggested_next_action: 'Fix the failing tests and retry',
      suggested_action: 'Fix tests',
    };

    expect(error.phase).toBe('VERIFYING');
    expect(error.iteration).toBe(2);
    expect(error.retryable).toBe(true);
    expect(error.evidence_paths).toHaveLength(1);
    expect(error.suggested_next_action).toBeTruthy();
  });

  it('AUDIT_BLOCKED maps to BLOCKED phase', () => {
    expect(ERROR_CATEGORY_DEFAULT_RESULT.get('AUDIT_BLOCKED')).toBe('BLOCKED');
  });

  it('LOCK_CONFLICT maps to BLOCKED phase', () => {
    expect(ERROR_CATEGORY_DEFAULT_RESULT.get('LOCK_CONFLICT')).toBe('BLOCKED');
  });

  it('INFRASTRUCTURE_ERROR maps to BLOCKED phase', () => {
    expect(ERROR_CATEGORY_DEFAULT_RESULT.get('INFRASTRUCTURE_ERROR')).toBe('BLOCKED');
  });

  it('USER_CANCELLED maps to CANCELLED phase', () => {
    expect(ERROR_CATEGORY_DEFAULT_RESULT.get('USER_CANCELLED')).toBe('CANCELLED');
  });
});
