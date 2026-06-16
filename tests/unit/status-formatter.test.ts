/**
 * Unit tests for status formatter.
 * Phase 4 §9.2: StatusOutput structure and formatting.
 */

import { describe, it, expect } from 'vitest';
import type { StatusOutput } from '../../src/types.js';

describe('StatusOutput structure', () => {
  it('has all required fields', () => {
    const output: StatusOutput = {
      run_id: 'run-001',
      phase: 'DEVELOPING',
      iteration: 1,
      max_iterations: 3,
      branch: 'agent/run-001-feature',
      base_commit: 'abc123',
      goal_digest: 'sha256:' + 'a'.repeat(64),
      audited_diff_digest: null,
      last_error: null,
      lock_status: 'held',
      lock_info: { run_id: 'run-001', pid: 12345, hostname: 'localhost', created_at: '2026-06-13T10:00:00.000Z' },
      started_at: '2026-06-13T10:00:00.000Z',
      updated_at: '2026-06-13T10:05:00.000Z',
      next_step: 'Developer is running (iteration 1/3). Wait for it to complete.',
    };

    expect(output.run_id).toBe('run-001');
    expect(output.phase).toBe('DEVELOPING');
    expect(output.iteration).toBe(1);
    expect(output.max_iterations).toBe(3);
    expect(output.lock_status).toBe('held');
    expect(output.next_step).toBeTruthy();
  });

  it('serializes to stable JSON', () => {
    const output: StatusOutput = {
      run_id: 'run-001',
      phase: 'VERIFYING',
      iteration: 2,
      max_iterations: 3,
      branch: 'agent/run-001-feature',
      base_commit: 'abc123',
      goal_digest: 'sha256:' + 'a'.repeat(64),
      audited_diff_digest: 'sha256:' + 'b'.repeat(64),
      last_error: null,
      lock_status: 'none',
      lock_info: null,
      started_at: '2026-06-13T10:00:00.000Z',
      updated_at: '2026-06-13T10:05:00.000Z',
      next_step: 'Verification is running (iteration 2/3). Wait for it to complete.',
    };

    const json = JSON.stringify(output, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.run_id).toBe('run-001');
    expect(parsed.phase).toBe('VERIFYING');
    expect(parsed.iteration).toBe(2);
  });

  it('handles terminal state hints', () => {
    const failedOutput: StatusOutput = {
      run_id: 'run-001',
      phase: 'FAILED',
      iteration: 3,
      max_iterations: 3,
      branch: 'agent/run-001-feature',
      base_commit: 'abc123',
      goal_digest: null,
      audited_diff_digest: null,
      last_error: { code: 'VERIFICATION_FAILED', message: 'Tests still fail', resumable: false, suggested_action: 'Fix tests' },
      lock_status: 'none',
      lock_info: null,
      started_at: '2026-06-13T10:00:00.000Z',
      updated_at: '2026-06-13T10:30:00.000Z',
      next_step: 'Run failed after 3 iteration(s). Review errors and adjust configuration.',
    };

    expect(failedOutput.phase).toBe('FAILED');
    expect(failedOutput.last_error).not.toBeNull();
    expect(failedOutput.next_step).toContain('failed');
  });
});
