/**
 * Resume Command — resume an interrupted run.
 * Phase 4 §9.3: `review-loop resume [--recover-lock]`
 *
 * Resume performs consistency checks and then re-enters the orchestrator loop
 * at the appropriate phase/iteration.
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { StateStore } from '../orchestrator/state-store.js';
import { LockManager } from '../runtime/lock-manager.js';
import { computeDigest } from '../runtime/digest.js';
import { runOrchestrator, type ResumeContext } from '../orchestrator/run-orchestrator.js';
import type { RunState } from '../types.js';
import { Phase as PhaseEnum } from '../types.js';
import { isTerminal } from '../orchestrator/state-machine.js';

export function createResumeCommand(): Command {
  const cmd = new Command('resume');
  cmd
    .description('Resume an interrupted run')
    .option('--recover-lock', 'Recover a stale lock file')
    .option('--config <path>', 'Configuration file path')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .action(async (options) => {
      try {
        await executeResume({
          project_root: options.projectRoot,
          recover_lock: options.recoverLock ?? false,
          config_path: options.config,
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  return cmd;
}

export class ResumeConsistencyError extends Error {
  constructor(
    message: string,
    public readonly reason?: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'ResumeConsistencyError';
  }
}

export async function executeResume(params: {
  project_root: string;
  recover_lock?: boolean;
  config_path?: string;
}): Promise<void> {
  const projectRoot = resolve(params.project_root);
  const agentDir = resolve(projectRoot, '.agent');

  // 1. Check .agent directory exists
  if (!existsSync(agentDir)) {
    throw new ResumeConsistencyError('No .agent directory found. No run to resume.');
  }

  // 2. Read state
  const stateStore = new StateStore(agentDir);
  if (!await stateStore.exists()) {
    throw new ResumeConsistencyError('No state.json found. No run to resume.');
  }

  let state: RunState;
  try {
    state = await stateStore.read();
  } catch (err) {
    throw new ResumeConsistencyError(`Failed to read state: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Check if already in terminal state
  if (isTerminal(state.phase)) {
    throw new ResumeConsistencyError(`Run ${state.run_id} is already in terminal state: ${state.phase}. Cannot resume a completed run.`);
  }

  // 4. Consistency checks
  const consistencyResult = await validateResumeConsistency(state, projectRoot);
  if (!consistencyResult.valid) {
    throw new ResumeConsistencyError(
      `Resume consistency check failed: ${consistencyResult.reason}`,
      consistencyResult.reason,
      consistencyResult.suggestion,
    );
  }

  // 5. Handle lock
  const lockManager = new LockManager(agentDir);
  const lock = await lockManager.readLock();

  if (lock) {
    let isAlive = false;
    try {
      process.kill(lock.pid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }

    if (isAlive && !params.recover_lock) {
      throw new ResumeConsistencyError(`Run is locked by active process (PID ${lock.pid}). Use --recover-lock to override.`);
    }

    if (!isAlive || params.recover_lock) {
      // Release stale lock
      try {
        await lockManager.release(lock.run_id);
        console.log('Released stale lock.');
      } catch {
        throw new ResumeConsistencyError('Failed to release lock. Try removing .agent/run.lock manually.');
      }
    }
  }

  // 6. Phase-specific recovery
  const recoveryAction = determineRecoveryAction(state);

  if (recoveryAction.action === 'blocked') {
    throw new ResumeConsistencyError(`Cannot resume from ${state.phase}: ${recoveryAction.reason}`);
  }

  if (recoveryAction.action === 'restart') {
    throw new ResumeConsistencyError(`Run ${state.run_id} needs to be restarted from scratch: ${recoveryAction.reason}. Use \`review-loop start\` with the same request to restart the run.`);
  }

  // 7. Re-enter the orchestrator loop
  console.log(`Resuming run ${state.run_id} from ${state.phase} (iteration ${state.iteration})...`);
  console.log(`Recovery: ${recoveryAction.reason}`);

  const resumeContext: ResumeContext = {
    run_id: state.run_id,
    iteration: state.iteration,
    phase: state.phase,
    branch: state.branch,
    base_commit: state.base_commit,
    task_slug: state.task_slug,
    goal_digest: state.goal_digest,
  };

  const result = await runOrchestrator({
    project_root: projectRoot,
    config_path: params.config_path,
    resume_from: resumeContext,
  });

  // Report the result
  if (result.phase === 'FINALIZING') {
    console.log(`Run ${state.run_id} completed successfully. Audit PASSED.`);
  } else if (result.phase === 'CANCELLED') {
    console.log(`Run ${state.run_id} was cancelled.`);
  } else if (result.phase === 'FAILED') {
    console.error(`Run ${state.run_id} failed: ${result.message}`);
  } else if (result.phase === 'BLOCKED') {
    console.error(`Run ${state.run_id} is blocked: ${result.message}`);
  } else {
    console.log(`Run ${state.run_id} ended in phase ${result.phase}: ${result.message}`);
  }
}

// ─── Consistency Validation ──────────────────────────────────

interface ConsistencyResult {
  valid: boolean;
  reason?: string;
  suggestion?: string;
}

async function validateResumeConsistency(
  state: RunState,
  projectRoot: string,
): Promise<ConsistencyResult> {
  const agentDir = resolve(projectRoot, '.agent');

  // Check cwd matches project_root
  if (resolve(projectRoot) !== resolve(state.project_root)) {
    return {
      valid: false,
      reason: `Current directory (${projectRoot}) does not match state.project_root (${state.project_root})`,
      suggestion: 'Run resume from the same project root as the original run.',
    };
  }

  // Check GOAL.md exists and digest matches
  const goalPath = resolve(agentDir, 'GOAL.md');
  if (!existsSync(goalPath)) {
    return {
      valid: false,
      reason: 'GOAL.md is missing from .agent/',
      suggestion: 'Ensure the .agent directory is intact.',
    };
  }

  if (state.goal_digest) {
    try {
      const goalContent = readFileSync(goalPath, 'utf8');
      const currentDigest = computeDigest(goalContent);
      if (currentDigest !== state.goal_digest) {
        return {
          valid: false,
          reason: 'GOAL.md digest does not match state.goal_digest',
          suggestion: 'GOAL.md may have been modified outside the orchestrator.',
        };
      }
    } catch {
      return {
        valid: false,
        reason: 'Cannot read GOAL.md to verify digest',
      };
    }
  }

  // Check plan.md exists
  const planPath = resolve(agentDir, 'plan.md');
  if (!existsSync(planPath)) {
    return {
      valid: false,
      reason: 'plan.md is missing from .agent/',
      suggestion: 'Ensure the .agent directory is intact.',
    };
  }

  // Check current Git branch matches state.branch
  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    if (currentBranch !== state.branch) {
      return {
        valid: false,
        reason: `Current Git branch (${currentBranch}) does not match state.branch (${state.branch})`,
        suggestion: `Switch to branch '${state.branch}' before resuming: git checkout ${state.branch}`,
      };
    }
  } catch {
    return {
      valid: false,
      reason: 'Cannot determine current Git branch. Is this a Git repository?',
      suggestion: 'Ensure the project root is a valid Git repository.',
    };
  }

  // Check base_commit still exists in the repository
  if (state.base_commit) {
    try {
      execSync(`git cat-file -t ${state.base_commit}`, {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch {
      return {
        valid: false,
        reason: `base_commit ${state.base_commit} no longer exists in the repository`,
        suggestion: 'The original base commit may have been garbage-collected or the repository was rewritten.',
      };
    }
  }

  return { valid: true };
}

// ─── Recovery Action ─────────────────────────────────────────

interface RecoveryAction {
  action: 'continue' | 'restart' | 'blocked';
  reason?: string;
}

function determineRecoveryAction(state: RunState): RecoveryAction {
  switch (state.phase) {
    case PhaseEnum.INITIALIZING:
      return { action: 'restart', reason: 'Run was interrupted during initialization.' };

    case PhaseEnum.PLANNING: {
      const agentDir = resolve(state.project_root, '.agent');
      const planExists = existsSync(resolve(agentDir, 'plan.md'));
      const goalExists = existsSync(resolve(agentDir, 'GOAL.md'));
      if (planExists && goalExists) {
        return { action: 'continue', reason: 'Plan and GOAL exist — can skip to DEVELOPING.' };
      }
      return { action: 'restart', reason: 'Plan or GOAL missing — need to re-run Planner.' };
    }

    case PhaseEnum.DEVELOPING:
    case PhaseEnum.REWORKING: {
      const agentDir = resolve(state.project_root, '.agent');
      const handoffExists = existsSync(resolve(agentDir, 'developer-handoff.md'));
      if (handoffExists) {
        return { action: 'continue', reason: 'Developer handoff exists — can skip to VERIFYING.' };
      }
      return { action: 'continue', reason: 'No handoff — need to re-run Developer.' };
    }

    case PhaseEnum.VERIFYING:
      return { action: 'continue', reason: 'Will re-run full verification.' };

    case PhaseEnum.AUDITING:
      return { action: 'continue', reason: 'Will re-run or validate Auditor.' };

    case PhaseEnum.FINALIZING:
      return { action: 'blocked', reason: 'Finalization requires Phase 5 capabilities.' };

    default:
      return { action: 'blocked', reason: `Unknown phase: ${state.phase}` };
  }
}
