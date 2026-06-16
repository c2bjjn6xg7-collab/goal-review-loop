/**
 * State machine — validates and enforces legal phase transitions.
 * Design doc §7.3
 */
import { Phase, LEGAL_TRANSITIONS, TERMINAL_PHASES, type RunState } from '../types.js';

export class StateMachineError extends Error {
  constructor(
    public readonly from: Phase,
    public readonly to: Phase,
    message: string,
  ) {
    super(message);
    this.name = 'StateMachineError';
  }
}

/**
 * Check if a transition from `current` to `next` is legal.
 */
export function isLegalTransition(current: Phase, next: Phase): boolean {
  const allowed = LEGAL_TRANSITIONS.get(current);
  if (!allowed) return false;
  return allowed.has(next);
}

/**
 * Validate and return the next phase, or throw if illegal.
 */
export function validateTransition(current: Phase, next: Phase): Phase {
  if (!isLegalTransition(current, next)) {
    throw new StateMachineError(
      current,
      next,
      `Illegal state transition: ${current} → ${next}. Allowed: ${[...(LEGAL_TRANSITIONS.get(current) ?? [])].join(', ')}`,
    );
  }
  return next;
}

/**
 * Check if a phase is terminal (no outgoing transitions).
 */
export function isTerminal(phase: Phase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/**
 * Get all allowed next phases for a given current phase.
 */
export function allowedNextPhases(phase: Phase): Phase[] {
  return [...(LEGAL_TRANSITIONS.get(phase) ?? [])];
}

/**
 * Compute the next phase after a failed verification.
 * If verification failed → REWORKING (or FAILED if max iterations reached, via REWORKING)
 */
export function nextAfterVerification(
  state: RunState,
  verificationPassed: boolean,
): Phase {
  if (verificationPassed) {
    return validateTransition(state.phase, Phase.AUDITING);
  }
  // Verification failed → rework
  // If max iterations reached, REWORKING will transition to FAILED
  return validateTransition(state.phase, Phase.REWORKING);
}

/**
 * Compute the next phase after an audit.
 * PASS → FINALIZING
 * FAIL → REWORKING (REWORKING will check max iterations and may go to FAILED)
 * BLOCKED → BLOCKED
 */
export function nextAfterAudit(
  state: RunState,
  decision: 'PASS' | 'FAIL' | 'BLOCKED',
): Phase {
  if (decision === 'PASS') {
    return validateTransition(state.phase, Phase.FINALIZING);
  }
  if (decision === 'BLOCKED') {
    return validateTransition(state.phase, Phase.BLOCKED);
  }
  // FAIL → rework (REWORKING will check max iterations)
  return validateTransition(state.phase, Phase.REWORKING);
}

/**
 * Check if rework is possible or if we should fail.
 * Call this after entering REWORKING phase.
 */
export function shouldFailAfterRework(state: RunState): boolean {
  return state.iteration >= state.max_iterations;
}