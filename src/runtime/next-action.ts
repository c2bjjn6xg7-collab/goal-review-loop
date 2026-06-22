/**
 * Pure helper that computes the next-action hint for a given phase.
 *
 * Extracted verbatim from src/cli/status.ts computeNextStep so the hint can be
 * surfaced in multiple surfaces (CLI status, CLI watch summary, dashboard
 * snapshot/HTML) without duplicating the phase→message mapping.
 */
import { Phase as PhaseEnum } from '../types.js';
import { isTerminal } from '../orchestrator/state-machine.js';

/**
 * Compute the next step suggestion based on current phase.
 */
export function computeNextAction(phase: string, iteration: number, maxIterations: number): string {
  if (isTerminal(phase as PhaseEnum)) {
    const p = phase as PhaseEnum;
    switch (p) {
      case PhaseEnum.PASSED:
        return 'Run completed successfully. Final Audit passed and code committed.';
      case PhaseEnum.FAILED:
        return `Run failed after ${iteration} iteration(s). Review errors and adjust configuration.`;
      case PhaseEnum.BLOCKED:
        return 'Run is blocked. Resolve the blocking issue and use `review-loop resume`.';
      case PhaseEnum.CANCELLED:
        return 'Run was cancelled.';
      default:
        return 'Run is in a terminal state.';
    }
  }

  switch (phase) {
    case 'INITIALIZING':
      return 'Run is initializing. Use `review-loop start` to begin.';
    case 'PLANNING':
      return 'Planner is running. Wait for it to complete.';
    case 'DEVELOPING':
      return `Developer is running (iteration ${iteration}/${maxIterations}). Wait for it to complete.`;
    case 'REWORKING':
      return `Rework is in progress (iteration ${iteration}/${maxIterations}). Wait for it to complete.`;
    case 'VERIFYING':
      return `Verification is running (iteration ${iteration}/${maxIterations}). Wait for it to complete.`;
    case 'AUDITING':
      return `Auditor is running (iteration ${iteration}/${maxIterations}). Wait for it to complete.`;
    case 'FINALIZING':
      return '正在等待或执行最终审计/本地提交';
    default:
      return 'Unknown phase.';
  }
}
