/**
 * Status Command — show current run status.
 * Phase 4 §9.2: `review-loop status [--json]`
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { StateStore } from '../orchestrator/state-store.js';
import { LockManager } from '../runtime/lock-manager.js';
import type { RunState, StatusOutput, ReviewLoopError } from '../types.js';
import { Phase as PhaseEnum } from '../types.js';
import { isTerminal } from '../orchestrator/state-machine.js';

export function createStatusCommand(): Command {
  const cmd = new Command('status');
  cmd
    .description('Show current run status')
    .option('--json', 'Output status as JSON')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .action(async (options) => {
      try {
        const result = await executeStatus({
          project_root: options.projectRoot,
          json: options.json ?? false,
        });
        if (result !== null) {
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printHumanReadable(result);
          }
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  return cmd;
}

export async function executeStatus(params: {
  project_root: string;
  json: boolean;
}): Promise<StatusOutput | null> {
  const projectRoot = resolve(params.project_root);
  const agentDir = resolve(projectRoot, '.agent');

  // Check if .agent directory exists
  if (!existsSync(agentDir)) {
    console.error('No .agent directory found. No run in progress.');
    return null;
  }

  // Read state
  const stateStore = new StateStore(agentDir);
  if (!await stateStore.exists()) {
    console.error('No state.json found. No run in progress.');
    return null;
  }

  let state: RunState;
  try {
    state = await stateStore.read();
  } catch (err) {
    console.error(`Failed to read state: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // Read lock
  const lockManager = new LockManager(agentDir);
  let lockStatus: 'held' | 'stale' | 'none' = 'none';

  try {
    const lock = await lockManager.readLock();
    if (lock) {
      // Check if the process is still alive
      try {
        process.kill(lock.pid, 0);
        lockStatus = 'held';
      } catch {
        lockStatus = 'stale';
      }
    }
  } catch {
    lockStatus = 'none';
  }

  const nextStep = computeNextStep(state.phase, state.iteration, state.max_iterations);

  const lock = await lockManager.readLock().catch(() => null);

  const lastError: ReviewLoopError | null = state.last_error
    ? { code: 'STATE_CONFLICT', message: state.last_error, resumable: false, suggested_action: 'Check configuration and try again' }
    : null;

  const output: StatusOutput = {
    run_id: state.run_id,
    phase: state.phase,
    iteration: state.iteration,
    max_iterations: state.max_iterations,
    branch: state.branch,
    base_commit: state.base_commit,
    goal_digest: state.goal_digest,
    audited_diff_digest: state.audited_diff_digest,
    last_error: lastError,
    lock_status: lockStatus,
    lock_info: lock,
    started_at: state.started_at,
    updated_at: state.updated_at,
    next_step: nextStep,
  };

  return output;
}

/**
 * Compute the next step suggestion based on current phase.
 */
function computeNextStep(phase: string, iteration: number, maxIterations: number): string {
  if (isTerminal(phase as PhaseEnum)) {
    const p = phase as PhaseEnum;
    switch (p) {
      case PhaseEnum.PASSED:
        return 'Run completed successfully. Phase 5 will handle finalization.';
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
      return 'Audit passed. Phase 5 will handle finalization.';
    default:
      return 'Unknown phase.';
  }
}

/**
 * Print human-readable status output.
 */
function printHumanReadable(status: StatusOutput): void {
  console.log(`Run: ${status.run_id}`);
  console.log(`Phase: ${status.phase}`);
  console.log(`Iteration: ${status.iteration}/${status.max_iterations}`);
  console.log(`Branch: ${status.branch}`);
  console.log(`Base commit: ${status.base_commit}`);
  console.log(`Started: ${status.started_at}`);
  console.log(`Updated: ${status.updated_at}`);

  if (status.goal_digest) {
    console.log(`GOAL digest: ${status.goal_digest}`);
  }
  if (status.audited_diff_digest) {
    console.log(`Diff digest: ${status.audited_diff_digest}`);
  }

  console.log(`Lock: ${status.lock_status}`);
  if (status.lock_info) {
    console.log(`  PID: ${status.lock_info.pid}`);
    console.log(`  Acquired: ${status.lock_info.created_at}`);
  }

  if (status.last_error) {
    console.log(`Last error: ${status.last_error.message}`);
  }

  console.log(`Next step: ${status.next_step}`);
}
