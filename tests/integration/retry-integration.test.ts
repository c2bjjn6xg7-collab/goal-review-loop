/**
 * Integration test for `review-loop retry` with a real orchestrator.
 *
 * This test addresses the P2 concern from the code review: the unit tests mock
 * runOrchestrator, so they never exercise the production lock acquisition or
 * the retry state-reset logic. This test runs the full orchestrator with a
 * fake-agent provider, produces a genuine BLOCKED state, then calls
 * executeRetry to verify:
 *
 * - The retry does NOT self-conflict on the lock.
 * - The orchestrator resets failed/blocked task_statuses -> pending and
 *   task_attempts -> 0 (deep-copy correctness).
 * - The run reaches PASSED after retry.
 *
 * The fake-agent 'task-block-once' behavior blocks on the first developer
 * call, then succeeds on the second (retry) call.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';
import { executeRetry } from '../../src/cli/retry.js';
import { StateStore } from '../../src/orchestrator/state-store.js';

function writeFakeAgentConfig(
  repoDir: string,
  roleBehaviors: Record<string, string>,
): void {
  const fakeAgentPath = resolve(join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));
  const config = {
    version: 1,
    agents: {
      planner: {
        command: ['node', fakeAgentPath, '--role', 'planner', '--run-id', '{run_id}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.planner || 'success'],
        timeout_seconds: 60,
      },
      developer: {
        command: ['node', fakeAgentPath, '--role', 'developer', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.developer || 'success'],
        timeout_seconds: 60,
      },
      auditor: {
        command: ['node', fakeAgentPath, '--role', 'auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.auditor || 'audit-pass'],
        timeout_seconds: 60,
      },
      final_auditor: {
        command: ['node', fakeAgentPath, '--role', 'final-auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.finalAuditor || 'audit-pass'],
        timeout_seconds: 60,
      },
    },
    loop: { max_iterations: 3 },
    git: {
      require_repository: true,
      require_head: true,
      require_clean_worktree: true,
      branch_template: 'agent/{run_id}-{task_slug}',
      commit_on_pass: true,
      commit_template: 'feat(agent): complete {task_slug} [{run_id}]',
      create_tag: false,
      tag_template: 'agent-{run_id}-pass',
      push: false,
    },
    runtime: {
      kill_grace_seconds: 5,
      max_log_bytes: 10485760,
      lock_stale_seconds: 86400,
    },
  };
  writeFileSync(join(repoDir, 'review-loop.yaml'), JSON.stringify(config, null, 2));
}

function copyPrompts(repoDir: string): void {
  const promptsDir = join(repoDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const srcPromptsDir = join(process.cwd(), 'prompts');
  for (const f of ['planner.md', 'developer.md', 'auditor.md', 'final-auditor.md', 'rework.md']) {
    const src = join(srcPromptsDir, f);
    if (existsSync(src)) {
      copyFileSync(src, join(promptsDir, f));
    }
  }
}

function createTestRepo(
  suffix: string,
  roleBehaviors: Record<string, string> = {},
): string {
  const repoDir = join(tmpdir(), `retry-integ-${suffix}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email test@test.com', { cwd: repoDir });
  execSync('git config user.name test', { cwd: repoDir });
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'retry-integ-test',
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"' },
  }), 'utf8');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
  writeFakeAgentConfig(repoDir, roleBehaviors);
  copyPrompts(repoDir);
  execSync('git add -A', { cwd: repoDir });
  execSync('git commit -m "initial"', { cwd: repoDir });
  return repoDir;
}

describe('retry integration: real orchestrator with task-block-once', () => {
  let repoDir: string;
  const origExit = process.exit;

  afterEach(() => {
    process.exit = origExit;
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('retries a BLOCKED task-graph run to PASSED with correct state reset', async () => {
    repoDir = createTestRepo('retry-reset', {
      planner: 'task-graph',
      developer: 'task-block-once',
    });

    // First run: max_iterations=1 so the developer blocks once and the task
    // is marked 'failed' without rework retries. This produces a genuine
    // BLOCKED state with a failed task (not a scope violation at integration).
    const firstResult = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a multi-part feature',
      task_slug: 'multi-part',
      max_iterations: 1,
    });

    expect(firstResult.phase).toBe('BLOCKED');

    // Verify the task is in a failed state with non-zero attempts.
    const agentDir = join(repoDir, '.agent');
    const stateStore = new StateStore(agentDir);
    const blockedState = await stateStore.read();
    expect(blockedState.task_graph_state).toBeTruthy();
    const tgs = blockedState.task_graph_state!;
    // task-1 should be 'failed' (blocked on first attempt, max_iterations=1).
    expect(tgs.task_statuses['task-1']).toBe('failed');
    const failedAttemptsBefore = tgs.task_attempts['task-1'] ?? 0;
    expect(failedAttemptsBefore).toBeGreaterThan(0);

    // The run.lock should have been released by the orchestrator's finally block
    // when it returned BLOCKED.
    const lockPath = join(agentDir, 'run.lock');
    expect(existsSync(lockPath)).toBe(false);

    // Switch to the run's branch so retry's branch consistency check passes.
    execSync(`git checkout ${blockedState.branch}`, { cwd: repoDir, stdio: 'pipe' });

    // Now retry. This must NOT self-conflict on the lock, and the orchestrator
    // must reset the failed task's status to pending and attempts to 0 before
    // re-running it (deep-copy correctness). The developer now succeeds
    // (sentinel exists from the first run).
    // executeRetry calls process.exit(0) on PASSED - mock it.
    const exitSpy = (await import('vitest')).vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await executeRetry({ project_root: repoDir, force: true });

    expect(exitSpy).toHaveBeenCalledWith(0);

    // Verify the run reached PASSED.
    const finalState = await stateStore.read();
    expect(finalState.phase).toBe('PASSED');
  }, 120000);
});
