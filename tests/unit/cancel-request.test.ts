/**
 * Unit tests for cancel request creation and parsing.
 * Phase 4 §9.4: CancelRequest schema validation.
 */

import { describe, it, expect } from 'vitest';
import { validateCancelRequest } from '../../src/artifacts/json-schemas.js';
import type { CancelRequest } from '../../src/types.js';

describe('CancelRequest schema validation', () => {
  it('validates a correct cancel request', () => {
    const request: CancelRequest = {
      schema_version: 1,
      run_id: 'run-001',
      requested_at: '2026-06-13T10:00:00.000Z',
      requested_by: 'cli:12345',
    };
    expect(validateCancelRequest(request)).toBe(true);
  });

  it('rejects missing required fields', () => {
    const request = {
      schema_version: 1,
      run_id: 'run-001',
      // missing requested_at and requested_by
    };
    expect(validateCancelRequest(request)).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    const request = {
      schema_version: 2,
      run_id: 'run-001',
      requested_at: '2026-06-13T10:00:00.000Z',
      requested_by: 'cli:12345',
    };
    expect(validateCancelRequest(request)).toBe(false);
  });

  it('rejects empty run_id', () => {
    const request = {
      schema_version: 1,
      run_id: '',
      requested_at: '2026-06-13T10:00:00.000Z',
      requested_by: 'cli:12345',
    };
    expect(validateCancelRequest(request)).toBe(false);
  });

  it('rejects additional properties', () => {
    const request = {
      schema_version: 1,
      run_id: 'run-001',
      requested_at: '2026-06-13T10:00:00.000Z',
      requested_by: 'cli:12345',
      extra_field: 'not allowed',
    };
    expect(validateCancelRequest(request)).toBe(false);
  });
});
