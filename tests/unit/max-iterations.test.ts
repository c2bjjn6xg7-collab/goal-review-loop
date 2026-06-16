/**
 * Unit tests for max iterations and shouldFailAfterRework.
 * Phase 4 §7: Iteration counting and failure boundaries.
 */

import { describe, it, expect } from 'vitest';
import { shouldFailAfterRework, isTerminal } from '../../src/orchestrator/state-machine.js';
import { Phase as PhaseEnum, type RunState } from '../../src/types.js';

function makeState(iteration: number, maxIterations: number): RunState {
  return {
    schema_version: 1,
    run_id: 'run-test',
    task_slug: 'test',
    phase: PhaseEnum.REWORKING,
    iteration,
    max_iterations: maxIterations,
    project_root: '/project',
    base_commit: 'abc123',
    branch: 'main',
    goal_digest: null,
    audited_diff_digest: null,
    started_at: '2026-06-13T10:00:00.000Z',
    updated_at: '2026-06-13T10:00:00.000Z',
    last_error: null,
    cancel_requested_at: null,
    stages: {},
  };
}

describe('shouldFailAfterRework', () => {
  it('returns true when iteration >= max_iterations', () => {
    expect(shouldFailAfterRework(makeState(3, 3))).toBe(true);
    expect(shouldFailAfterRework(makeState(4, 3))).toBe(true);
  });

  it('returns false when iteration < max_iterations', () => {
    expect(shouldFailAfterRework(makeState(1, 3))).toBe(false);
    expect(shouldFailAfterRework(makeState(2, 3))).toBe(false);
  });

  it('handles max_iterations = 1', () => {
    expect(shouldFailAfterRework(makeState(1, 1))).toBe(true);
  });

  it('handles max_iterations = 10', () => {
    expect(shouldFailAfterRework(makeState(9, 10))).toBe(false);
    expect(shouldFailAfterRework(makeState(10, 10))).toBe(true);
  });
});

describe('isTerminal', () => {
  it('identifies terminal phases', () => {
    expect(isTerminal(PhaseEnum.PASSED)).toBe(true);
    expect(isTerminal(PhaseEnum.FAILED)).toBe(true);
    expect(isTerminal(PhaseEnum.BLOCKED)).toBe(true);
    expect(isTerminal(PhaseEnum.CANCELLED)).toBe(true);
  });

  it('identifies non-terminal phases', () => {
    expect(isTerminal(PhaseEnum.INITIALIZING)).toBe(false);
    expect(isTerminal(PhaseEnum.PLANNING)).toBe(false);
    expect(isTerminal(PhaseEnum.DEVELOPING)).toBe(false);
    expect(isTerminal(PhaseEnum.VERIFYING)).toBe(false);
    expect(isTerminal(PhaseEnum.AUDITING)).toBe(false);
    expect(isTerminal(PhaseEnum.REWORKING)).toBe(false);
    expect(isTerminal(PhaseEnum.FINALIZING)).toBe(false);
  });
});
