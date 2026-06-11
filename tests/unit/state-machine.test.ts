import { describe, it, expect } from 'vitest';
import {
  isLegalTransition,
  validateTransition,
  isTerminal,
  allowedNextPhases,
  nextAfterVerification,
  nextAfterAudit,
  shouldFailAfterRework,
  StateMachineError,
} from '../../src/orchestrator/state-machine.js';
import { Phase, type RunState } from '../../src/types.js';

describe('State Machine', () => {
  describe('isLegalTransition', () => {
    it('should allow INITIALIZING → PLANNING', () => {
      expect(isLegalTransition(Phase.INITIALIZING, Phase.PLANNING)).toBe(true);
    });

    it('should allow PLANNING → DEVELOPING', () => {
      expect(isLegalTransition(Phase.PLANNING, Phase.DEVELOPING)).toBe(true);
    });

    it('should allow DEVELOPING → VERIFYING', () => {
      expect(isLegalTransition(Phase.DEVELOPING, Phase.VERIFYING)).toBe(true);
    });

    it('should allow VERIFYING → AUDITING', () => {
      expect(isLegalTransition(Phase.VERIFYING, Phase.AUDITING)).toBe(true);
    });

    it('should allow VERIFYING → REWORKING', () => {
      expect(isLegalTransition(Phase.VERIFYING, Phase.REWORKING)).toBe(true);
    });

    it('should allow AUDITING → FINALIZING', () => {
      expect(isLegalTransition(Phase.AUDITING, Phase.FINALIZING)).toBe(true);
    });

    it('should allow AUDITING → REWORKING', () => {
      expect(isLegalTransition(Phase.AUDITING, Phase.REWORKING)).toBe(true);
    });

    it('should allow REWORKING → VERIFYING', () => {
      expect(isLegalTransition(Phase.REWORKING, Phase.VERIFYING)).toBe(true);
    });

    it('should allow FINALIZING → PASSED', () => {
      expect(isLegalTransition(Phase.FINALIZING, Phase.PASSED)).toBe(true);
    });

    it('should allow any active phase → BLOCKED', () => {
      const activePhases = [
        Phase.INITIALIZING, Phase.PLANNING, Phase.DEVELOPING,
        Phase.VERIFYING, Phase.AUDITING, Phase.REWORKING,
      ];
      for (const phase of activePhases) {
        expect(isLegalTransition(phase, Phase.BLOCKED)).toBe(true);
      }
    });

    it('should allow any active phase → CANCELLED', () => {
      const activePhases = [
        Phase.INITIALIZING, Phase.PLANNING, Phase.DEVELOPING,
        Phase.VERIFYING, Phase.AUDITING, Phase.REWORKING,
      ];
      for (const phase of activePhases) {
        expect(isLegalTransition(phase, Phase.CANCELLED)).toBe(true);
      }
    });

    it('should reject INITIALIZING → DEVELOPING (skip PLANNING)', () => {
      expect(isLegalTransition(Phase.INITIALIZING, Phase.DEVELOPING)).toBe(false);
    });

    it('should reject DEVELOPING → AUDITING (skip VERIFYING)', () => {
      expect(isLegalTransition(Phase.DEVELOPING, Phase.AUDITING)).toBe(false);
    });

    it('should reject PASSED → DEVELOPING (terminal)', () => {
      expect(isLegalTransition(Phase.PASSED, Phase.DEVELOPING)).toBe(false);
    });

    it('should reject FAILED → any (terminal)', () => {
      for (const phase of Object.values(Phase)) {
        expect(isLegalTransition(Phase.FAILED, phase)).toBe(false);
      }
    });

    it('should reject BLOCKED → any (terminal)', () => {
      for (const phase of Object.values(Phase)) {
        expect(isLegalTransition(Phase.BLOCKED, phase)).toBe(false);
      }
    });

    it('should reject CANCELLED → any (terminal)', () => {
      for (const phase of Object.values(Phase)) {
        expect(isLegalTransition(Phase.CANCELLED, phase)).toBe(false);
      }
    });

    it('should reject REWORKING → DEVELOPING (must go to VERIFYING)', () => {
      expect(isLegalTransition(Phase.REWORKING, Phase.DEVELOPING)).toBe(false);
    });

    it('should allow REWORKING → FAILED (max iterations reached)', () => {
      expect(isLegalTransition(Phase.REWORKING, Phase.FAILED)).toBe(true);
    });
  });

  describe('validateTransition', () => {
    it('should return the target phase for legal transitions', () => {
      expect(validateTransition(Phase.INITIALIZING, Phase.PLANNING)).toBe(Phase.PLANNING);
    });

    it('should throw StateMachineError for illegal transitions', () => {
      expect(() => validateTransition(Phase.PASSED, Phase.DEVELOPING)).toThrow(StateMachineError);
    });

    it('should include from/to in error', () => {
      try {
        validateTransition(Phase.PASSED, Phase.DEVELOPING);
      } catch (err) {
        expect(err).toBeInstanceOf(StateMachineError);
        const sme = err as StateMachineError;
        expect(sme.from).toBe(Phase.PASSED);
        expect(sme.to).toBe(Phase.DEVELOPING);
      }
    });
  });

  describe('isTerminal', () => {
    it('should return true for terminal phases', () => {
      expect(isTerminal(Phase.PASSED)).toBe(true);
      expect(isTerminal(Phase.FAILED)).toBe(true);
      expect(isTerminal(Phase.BLOCKED)).toBe(true);
      expect(isTerminal(Phase.CANCELLED)).toBe(true);
    });

    it('should return false for active phases', () => {
      expect(isTerminal(Phase.INITIALIZING)).toBe(false);
      expect(isTerminal(Phase.PLANNING)).toBe(false);
      expect(isTerminal(Phase.DEVELOPING)).toBe(false);
      expect(isTerminal(Phase.VERIFYING)).toBe(false);
      expect(isTerminal(Phase.AUDITING)).toBe(false);
      expect(isTerminal(Phase.REWORKING)).toBe(false);
      expect(isTerminal(Phase.FINALIZING)).toBe(false);
    });
  });

  describe('allowedNextPhases', () => {
    it('should return correct allowed phases for INITIALIZING', () => {
      const allowed = allowedNextPhases(Phase.INITIALIZING);
      expect(allowed).toContain(Phase.PLANNING);
      expect(allowed).toContain(Phase.BLOCKED);
      expect(allowed).toContain(Phase.CANCELLED);
      expect(allowed).toHaveLength(3);
    });

    it('should return empty array for terminal phases', () => {
      expect(allowedNextPhases(Phase.PASSED)).toHaveLength(0);
      expect(allowedNextPhases(Phase.FAILED)).toHaveLength(0);
    });
  });

  describe('nextAfterVerification', () => {
    const baseState: RunState = {
      schema_version: 1,
      run_id: 'test',
      task_slug: 'test',
      phase: Phase.VERIFYING,
      iteration: 1,
      max_iterations: 3,
      project_root: '/tmp/test',
      base_commit: 'abc123',
      branch: 'agent/test',
      goal_digest: null,
      audited_diff_digest: null,
      started_at: '2026-06-10T00:00:00Z',
      updated_at: '2026-06-10T00:00:00Z',
      last_error: null,
      stages: {},
    };

    it('should return AUDITING when verification passes', () => {
      expect(nextAfterVerification(baseState, true)).toBe(Phase.AUDITING);
    });

    it('should return REWORKING when verification fails and iterations remain', () => {
      expect(nextAfterVerification(baseState, false)).toBe(Phase.REWORKING);
    });

    it('should return REWORKING when verification fails (even at max iterations)', () => {
      const maxedState = { ...baseState, iteration: 3 };
      // VERIFYING can only go to REWORKING, not directly to FAILED
      expect(nextAfterVerification(maxedState, false)).toBe(Phase.REWORKING);
    });
  });

  describe('nextAfterAudit', () => {
    const baseState: RunState = {
      schema_version: 1,
      run_id: 'test',
      task_slug: 'test',
      phase: Phase.AUDITING,
      iteration: 1,
      max_iterations: 3,
      project_root: '/tmp/test',
      base_commit: 'abc123',
      branch: 'agent/test',
      goal_digest: null,
      audited_diff_digest: null,
      started_at: '2026-06-10T00:00:00Z',
      updated_at: '2026-06-10T00:00:00Z',
      last_error: null,
      stages: {},
    };

    it('should return FINALIZING when audit passes', () => {
      expect(nextAfterAudit(baseState, 'PASS')).toBe(Phase.FINALIZING);
    });

    it('should return BLOCKED when audit is blocked', () => {
      expect(nextAfterAudit(baseState, 'BLOCKED')).toBe(Phase.BLOCKED);
    });

    it('should return REWORKING when audit fails and iterations remain', () => {
      expect(nextAfterAudit(baseState, 'FAIL')).toBe(Phase.REWORKING);
    });

    it('should return REWORKING when audit fails (even at max iterations)', () => {
      const maxedState = { ...baseState, iteration: 3 };
      // AUDITING can only go to REWORKING, not directly to FAILED
      expect(nextAfterAudit(maxedState, 'FAIL')).toBe(Phase.REWORKING);
    });
  });

  describe('shouldFailAfterRework', () => {
    const baseState: RunState = {
      schema_version: 1,
      run_id: 'test',
      task_slug: 'test',
      phase: Phase.REWORKING,
      iteration: 1,
      max_iterations: 3,
      project_root: '/tmp/test',
      base_commit: 'abc123',
      branch: 'agent/test',
      goal_digest: null,
      audited_diff_digest: null,
      started_at: '2026-06-10T00:00:00Z',
      updated_at: '2026-06-10T00:00:00Z',
      last_error: null,
      stages: {},
    };

    it('should return false when iterations remain', () => {
      expect(shouldFailAfterRework(baseState)).toBe(false);
    });

    it('should return true when max iterations reached', () => {
      const maxedState = { ...baseState, iteration: 3 };
      expect(shouldFailAfterRework(maxedState)).toBe(true);
    });
  });
});