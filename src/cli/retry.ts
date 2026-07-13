/**
 * Retry Command — retry a BLOCKED run from the point of failure.
 *
 * When a run reaches BLOCKED (task failed, planner failed, integration failed),
 * `review-loop retry` resets the failed parts and resumes execution.
 * Passed tasks are skipped; only failed/pending tasks are re-run.
 */
import { Command } from 'commander';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { StateStore } from '../orchestrator/state-store.js';
import { LockManager } from '../runtime/lock-manager.js';
import { runOrchestrator } from '../orchestrator/run-orchestrator.js';

export function createRetryCommand(): Command {
  const cmd = new Command('retry');
  cmd
    .description('Retry a BLOCKED run from the point of failure')
    .option('--force', 'Skip confirmation prompt')
    .option('--recover-lock', 'Recover a stale lock file')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .option('--config <path>', 'Configuration file path')
    .action(async (options) => {
      try {
        await executeRetry({
          project_root: options.projectRoot,
          force: options.force ?? false,
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

export async function executeRetry(params: {
  project_root: string;
  force?: boolean;
  recover_lock?: boolean;
  config_path?: string;
}): Promise<void> {
  const projectRoot = resolve(params.project_root);
  const agentDir = join(projectRoot, '.agent');
  const statePath = join(agentDir, 'state.json');

  if (!existsSync(statePath)) {
    console.error('No run state found. Use "review-loop start" to begin a new run.');
    process.exit(1);
  }

  const stateStore = new StateStore(agentDir);
  const state = await stateStore.read();

  if (state.phase !== 'BLOCKED') {
    console.error(`Run is in phase ${state.phase}, not BLOCKED. Use "review-loop resume" instead.`);
    process.exit(1);
  }

  console.log(`\nRun: ${state.run_id} (BLOCKED)`);
  console.log(`Reason: ${state.last_error ?? 'unknown'}\n`);

  // Check task-graph state for task-level details
  let taskSummary = '';
  let failedTaskCount = 0;
  if (state.task_graph_state) {
    const tgs = state.task_graph_state;
    const statuses = tgs.task_statuses ?? {};
    console.log('Tasks:');
    for (const [taskId, status] of Object.entries(statuses)) {
      const icon = status === 'passed' ? '✓' : status === 'failed' || status === 'blocked' ? '✗' : '○';
      const action = status === 'passed' ? 'skip' : 'retry';
      console.log(`  ${taskId}: ${status} ${icon} (${action})`);
      if (status !== 'passed') failedTaskCount++;
    }
    taskSummary = `${failedTaskCount} task(s) to retry`;
  } else {
    console.log('No task-graph state — will retry from the blocked phase.');
    taskSummary = 'retry from blocked phase';
  }
  console.log('');

  // Confirm
  if (!params.force) {
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Proceed with retry (${taskSummary})? [y/N]: `, (a) => {
        rl.close();
        resolve(a.trim().toLowerCase());
      });
    });
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Retry cancelled.');
      return;
    }
  }

  // Recover lock if needed.
  //
  // Like `resume`, we do NOT acquire the lock here - the orchestrator owns lock
  // acquisition. Acquiring at the CLI layer would cause a spurious self-conflict
  // when the orchestrator re-acquires the same lock (the process would see its
  // own PID and bail out with "Another run is active"). Instead we only release
  // a stale lock left behind by a crashed previous run, then let the orchestrator
  // take a fresh lock.
  const lockManager = new LockManager(agentDir);
  const lock = await lockManager.readLock();
  if (lock) {
    let isAlive = false;
    // Skip liveness check for malformed/corrupted locks (pid <= 0) to avoid
    // calling process.kill(-1, 0), which would signal the entire process group.
    if (lock.pid > 0) {
      try {
        process.kill(lock.pid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }
    }

    if (isAlive && !params.recover_lock) {
      console.error(`Run is locked by active process (PID ${lock.pid}). Use --recover-lock to override.`);
      process.exit(1);
    }

    if (!isAlive || params.recover_lock) {
      try {
        await lockManager.release(lock.run_id);
        console.log('Released stale lock.');
      } catch {
        console.error('Failed to release lock. Try removing .agent/run.lock manually.');
        process.exit(1);
      }
    }
  }

  console.log('Retrying...\n');

  // Resume the run. The orchestrator acquires the lock, runs F-403 consistency
  // checks, and only THEN resets failed/blocked tasks (is_retry: true). This
  // ensures state.json is never modified without holding the lock, eliminating
  // the race where a concurrent run grabs the lock between our precheck and the
  // orchestrator's acquisition.
  const result = await runOrchestrator({
    project_root: projectRoot,
    resume_from: {
      run_id: state.run_id,
      iteration: state.iteration,
      phase: 'BLOCKED' as never,
      branch: state.branch,
      base_commit: state.base_commit,
      task_slug: state.task_slug ?? '',
      goal_digest: state.goal_digest ?? null,
      is_retry: true,
    },
    config_path: params.config_path,
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Phase:      ${result.phase}`);
  console.log(`Message:    ${result.message}`);
  if (result.phase === 'PASSED' && result.commit_sha) {
    console.log(`Commit:     ${result.commit_sha}`);
  }
  process.exit(result.phase === 'PASSED' ? 0 : 1);
}
