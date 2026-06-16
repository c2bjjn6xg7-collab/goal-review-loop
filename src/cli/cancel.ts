/**
 * Cancel Command — cancel the current run.
 * Phase 4 §9.4: `review-loop cancel`
 *
 * Cancel works by:
 * 1. Writing `.agent/cancel-request.json`
 * 2. Sending SIGTERM to the orchestrator PID
 * 3. Waiting up to cancel_grace_seconds for the process to exit
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { StateStore } from '../orchestrator/state-store.js';
import { LockManager } from '../runtime/lock-manager.js';
import { atomicWriteJSON } from '../runtime/atomic-file.js';
import { loadConfigWithDefaults } from '../artifacts/config.js';
import type { CancelRequest } from '../types.js';

export function createCancelCommand(): Command {
  const cmd = new Command('cancel');
  cmd
    .description('Cancel the current run')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .option('--config <path>', 'Configuration file path')
    .action(async (options) => {
      try {
        await executeCancel({
          project_root: options.projectRoot,
          config_path: options.config,
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  return cmd;
}

export async function executeCancel(params: {
  project_root: string;
  config_path?: string;
}): Promise<void> {
  const projectRoot = resolve(params.project_root);
  const agentDir = resolve(projectRoot, '.agent');

  // Check if .agent directory exists
  if (!existsSync(agentDir)) {
    console.error('No .agent directory found. No run in progress.');
    return;
  }

  // Read state
  const stateStore = new StateStore(agentDir);
  if (!await stateStore.exists()) {
    console.error('No state.json found. No run in progress.');
    return;
  }

  const state = await stateStore.read();

  // Check if already in a terminal state
  if (['PASSED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(state.phase)) {
    console.log(`Run ${state.run_id} is already in terminal state: ${state.phase}`);
    return;
  }

  // Read lock to find the orchestrator PID
  const lockManager = new LockManager(agentDir);
  const lock = await lockManager.readLock();

  if (!lock) {
    console.log('No active lock found. Writing cancel request anyway.');
  } else {
    // Check if the process is still alive
    let isAlive = false;
    try {
      process.kill(lock.pid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }

    if (!isAlive) {
      console.log(`Orchestrator process (PID ${lock.pid}) is no longer running.`);
      console.log('The run may be stale. Consider `review-loop resume --recover-lock`.');
      return;
    }
  }

  // Write cancel request
  const cancelRequest: CancelRequest = {
    schema_version: 1,
    run_id: state.run_id,
    requested_at: new Date().toISOString(),
    requested_by: `cli:${process.pid}`,
  };

  const cancelPath = resolve(agentDir, 'cancel-request.json');
  await atomicWriteJSON(cancelPath, cancelRequest);
  console.log(`Cancel request written for run ${state.run_id}`);

  // Send SIGTERM to the orchestrator process
  if (lock) {
    try {
      process.kill(lock.pid, 'SIGTERM');
      console.log(`SIGTERM sent to process ${lock.pid}`);

      // Load config for grace period
      const config = await loadConfigWithDefaults(projectRoot, params.config_path);
      const graceSeconds = config.runtime.cancel_grace_seconds;

      // Wait for the process to exit
      const startTime = Date.now();
      const maxWaitMs = graceSeconds * 1000;

      while (Date.now() - startTime < maxWaitMs) {
        try {
          process.kill(lock.pid, 0);
          // Process still alive, wait a bit
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch {
          // Process has exited
          console.log(`Process ${lock.pid} has exited.`);
          return;
        }
      }

      console.log(`Process ${lock.pid} did not exit within ${graceSeconds}s grace period.`);
      console.log('The cancel request file is still in place — the orchestrator will check it on next iteration.');
    } catch (err) {
      console.error(`Failed to send SIGTERM: ${err instanceof Error ? err.message : String(err)}`);
      console.log('The cancel request file is still in place — the orchestrator will check it on next iteration.');
    }
  }
}
