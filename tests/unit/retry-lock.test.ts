/**
 * Regression tests for the `retry` CLI command's lock-handling and state-reset
 * behavior (issue 026: retry CLI and orchestrator double-acquire the run lock).
 *
 * Key invariant under test: `executeRetry` must NOT modify state.json before
 * the orchestrator acquires the lock. The task-status reset (failed/blocked ->
 * pending, attempts -> 0, last_error -> null) is performed by the orchestrator
 * after lock acquisition, not by the CLI layer.
 *
 * `runOrchestrator` is mocked so we can assert the CLI-layer behavior without
 * starting real AI agents.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execSync } from 'node:child_process';
import { StateStore } from '../../src/orchestrator/state-store.js';
import { LockManager } from '../../src/runtime/lock-manager.js';
import type { OrchestratorResult } from '../../src/orchestrator/run-orchestrator.js';
import type { RunState, TaskGraphState } from '../../src/types.js';

// Track every call to runOrchestrator so tests can assert resume_from params.
let orchestratorCalls: { resume_from?: { is_retry?: boolean; [k: string]: unknown } }[] = [];

// Partial mock: replace runOrchestrator with a spy, keep all other exports.
vi.mock('../../src/orchestrator/run-orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    runOrchestrator: vi.fn(async (params: {
      resume_from?: { is_retry?: boolean; [k: string]: unknown };
    }): Promise<OrchestratorResult> => {
      orchestratorCalls.push({ resume_from: params.resume_from });
      return {
        run_id: 'test-run',
        phase: 'PASSED',
        exit_code: 0,
        branch: 'main',
        audit_decision: 'PASS',
        artifact_paths: [],
        next_action: '',
        message: 'mocked',
        error: null,
        commit_sha: null,
        commit_skipped: false,
        tag_name: null,
        tag_created: false,
        skip_reason: null,
      };
    }),
  };
});

// Import AFTER mock is set up.
const { executeRetry } = await import('../../src/cli/retry.js');
const { runOrchestrator } = await import('../../src/orchestrator/run-orchestrator.js');

// ─── Helpers ────────────────────────────────────────────────────

interface TestEnv {
  tmpDir: string;
  projectRoot: string;
  agentDir: string;
  stateStore: StateStore;
  lockManager: LockManager;
  lockPath: string;
  statePath: string;
}

async function createTestEnv(opts?: {
  withTaskGraph?: boolean;
}): Promise<TestEnv> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'retry-lock-test-'));
  const projectRoot = tmpDir;
  const agentDir = path.join(tmpDir, '.agent');
  await fs.ensureDir(agentDir);

  // Initialize a git repo so consistency checks don't fail on missing git.
  try {
    execSync('git init -b main', { cwd: projectRoot, stdio: 'pipe' });
    execSync('git config user.email test@test', { cwd: projectRoot, stdio: 'pipe' });
    execSync('git config user.name test', { cwd: projectRoot, stdio: 'pipe' });
    await fs.writeFile(path.join(projectRoot, 'README.md'), 'test');
    execSync('git add .', { cwd: projectRoot, stdio: 'pipe' });
    execSync('git commit -m init', { cwd: projectRoot, stdio: 'pipe' });
  } catch {
    // git may not be available in all CI environments.
  }

  const stateStore = new StateStore(agentDir);
  const lockManager = new LockManager(agentDir);
  const lockPath = path.join(agentDir, 'run.lock');
  const statePath = path.join(agentDir, 'state.json');

  // Create initial state and transition to BLOCKED.
  const baseCommit = safeRevParse(projectRoot);
  await stateStore.create({
    run_id: 'test-run',
    task_slug: 'test-task',
    project_root: projectRoot,
    base_commit: baseCommit,
    branch: 'main',
    max_iterations: 3,
  });
  await stateStore.transition('PLANNING' as never);
  await stateStore.transition('BLOCKED' as never);

  if (opts?.withTaskGraph) {
    const tgs: TaskGraphState = {
      current_task_index: 0,
      task_statuses: { 'task-1': 'failed', 'task-2': 'passed' },
      task_attempts: { 'task-1': 2, 'task-2': 1 },
    };
    await stateStore.update(() => ({
      task_graph_state: tgs,
      last_error: 'task-1 failed',
    }));
  } else {
    await stateStore.update(() => ({ last_error: 'planner failed' }));
  }

  return { tmpDir, projectRoot, agentDir, stateStore, lockManager, lockPath, statePath };
}

function safeRevParse(projectRoot: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim();
  } catch {
    return '0000000000000000000000000000000000000000';
  }
}

function writeLock(
  lockPath: string,
  opts: { pid: number; run_id?: string; ageMs?: number },
): void {
  const lockInfo = {
    run_id: opts.run_id ?? 'test-run',
    pid: opts.pid,
    hostname: os.hostname(),
    created_at: new Date(Date.now() - (opts.ageMs ?? 0)).toISOString(),
  };
  fs.writeJSONSync(lockPath, lockInfo);
}

async function readStateRaw(statePath: string): Promise<RunState> {
  return JSON.parse(await fs.readFile(statePath, 'utf8')) as RunState;
}

/**
 * Mock process.exit to throw, so the test runner survives and we can catch
 * the error. Use for paths where executeRetry calls process.exit(1).
 */
function mockProcessExitThrows(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit was called');
  }) as never);
}

/**
 * Mock process.exit to be a no-op. Use for success paths where executeRetry
 * calls process.exit(0) - we want execution to continue so we can assert state.
 */
function mockProcessExitNoop(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
}

function assertStateUntouched(statePath: string): Promise<void> {
  return readStateRaw(statePath).then((state) => {
    expect(state.task_graph_state!.task_statuses['task-1']).toBe('failed');
    expect(state.task_graph_state!.task_attempts['task-1']).toBe(2);
    expect(state.last_error).toBe('task-1 failed');
  });
}

// ─── Tests ──────────────────────────────────────────────────────

describe('executeRetry lock handling and state-reset safety', () => {
  let env: TestEnv;
  const origExit = process.exit;

  beforeEach(() => {
    orchestratorCalls = [];
    // Reset the default mock implementation for each test.
    vi.mocked(runOrchestrator).mockImplementation(async (params: {
      resume_from?: { is_retry?: boolean; [k: string]: unknown };
    }) => {
      orchestratorCalls.push({ resume_from: params.resume_from });
      return {
        run_id: 'test-run',
        phase: 'PASSED',
        exit_code: 0,
        branch: 'main',
        audit_decision: 'PASS',
        artifact_paths: [],
        next_action: '',
        message: 'mocked',
        error: null,
        commit_sha: null,
        commit_skipped: false,
        tag_name: null,
        tag_created: false,
        skip_reason: null,
      };
    });
  });

  afterEach(async () => {
    process.exit = origExit;
    vi.restoreAllMocks();
    if (env) await fs.remove(env.tmpDir);
  });

  it('no lock: retry --force does not self-conflict and does not modify state', async () => {
    env = await createTestEnv({ withTaskGraph: true });
    mockProcessExitNoop();

    await executeRetry({ project_root: env.projectRoot, force: true });

    // Orchestrator was called with is_retry: true.
    expect(orchestratorCalls).toHaveLength(1);
    expect(orchestratorCalls[0].resume_from?.is_retry).toBe(true);

    // CLI layer must NOT have modified task_statuses / task_attempts / last_error.
    // The reset is now the orchestrator's responsibility.
    await assertStateUntouched(env.statePath);
  });

  it('active lock without --recover-lock: rejects and does not modify state', async () => {
    env = await createTestEnv({ withTaskGraph: true });
    writeLock(env.lockPath, { pid: process.pid }); // alive = current process
    const exitSpy = mockProcessExitThrows();

    await expect(
      executeRetry({ project_root: env.projectRoot, force: true }),
    ).rejects.toThrow('process.exit was called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(orchestratorCalls).toHaveLength(0); // orchestrator never called

    // State must be untouched.
    await assertStateUntouched(env.statePath);
  });

  it('dead-process lock: releases stale lock and proceeds, state untouched by CLI', async () => {
    env = await createTestEnv({ withTaskGraph: true });
    writeLock(env.lockPath, { pid: 999999 }); // reliably dead
    mockProcessExitNoop();

    await executeRetry({ project_root: env.projectRoot, force: true });

    // Stale lock was removed.
    expect(await fs.pathExists(env.lockPath)).toBe(false);
    // Orchestrator was called.
    expect(orchestratorCalls).toHaveLength(1);
    expect(orchestratorCalls[0].resume_from?.is_retry).toBe(true);

    // CLI did not modify state.
    await assertStateUntouched(env.statePath);
  });

  it('active lock with --recover-lock: releases and proceeds (matches resume)', async () => {
    env = await createTestEnv({ withTaskGraph: true });
    writeLock(env.lockPath, { pid: process.pid }); // alive
    mockProcessExitNoop();

    await executeRetry({ project_root: env.projectRoot, force: true, recover_lock: true });

    // Lock was released.
    expect(await fs.pathExists(env.lockPath)).toBe(false);
    // Orchestrator was called.
    expect(orchestratorCalls).toHaveLength(1);
    expect(orchestratorCalls[0].resume_from?.is_retry).toBe(true);
  });

  it('concurrent process grabs lock after precheck: retry returns conflict, state unmodified', async () => {
    env = await createTestEnv({ withTaskGraph: true });

    // Override the mock: simulate a race where a concurrent process acquires
    // the lock BETWEEN the CLI precheck and the orchestrator's acquisition.
    // The orchestrator mock writes an active lock (the "other" process) and
    // returns a STATE_CONFLICT BLOCKED result.
    vi.mocked(runOrchestrator).mockImplementationOnce(async (params: {
      resume_from?: { is_retry?: boolean; [k: string]: unknown };
    }) => {
      orchestratorCalls.push({ resume_from: params.resume_from });
      // Simulate the concurrent process holding the lock when orchestrator
      // tries to acquire it.
      writeLock(env.lockPath, { pid: process.pid, run_id: 'other-run' });
      return {
        run_id: 'test-run',
        phase: 'BLOCKED',
        exit_code: 1,
        branch: 'main',
        audit_decision: null,
        artifact_paths: [],
        next_action: 'Resolve BLOCKED issue',
        message: 'Lock acquisition failed on resume: Another run is active',
        error: { code: 'STATE_CONFLICT', message: 'conflict', resumable: false, suggested_action: '' },
        commit_sha: null,
        commit_skipped: false,
        tag_name: null,
        tag_created: false,
        skip_reason: null,
      };
    });

    // executeRetry will call process.exit(1) because result.phase !== PASSED.
    mockProcessExitThrows();

    await expect(
      executeRetry({ project_root: env.projectRoot, force: true }),
    ).rejects.toThrow('process.exit was called');

    // The orchestrator was called (and returned conflict).
    expect(orchestratorCalls).toHaveLength(1);

    // CRITICAL: state.json must still show failed/blocked - the CLI layer did
    // NOT reset anything before the orchestrator (which failed to get the lock).
    await assertStateUntouched(env.statePath);
  });

  it('malformed/corrupted lock: does not call process.kill(-1, 0) and does not crash', async () => {
    env = await createTestEnv({ withTaskGraph: true });
    // Write a corrupted lock file (invalid JSON) - readLock returns pid: -1.
    await fs.writeFile(env.lockPath, 'not valid json');

    // Spy on process.kill to ensure it's never called with pid <= 0.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    // With a corrupted lock (pid=-1), the pid>0 guard skips the liveness check,
    // so isAlive stays false. The release attempt will fail (malformed lock),
    // and executeRetry calls process.exit(1).
    mockProcessExitThrows();

    await expect(
      executeRetry({ project_root: env.projectRoot, force: true }),
    ).rejects.toThrow('process.exit was called');

    // process.kill was never called with -1 (or any pid <= 0).
    for (const call of killSpy.mock.calls) {
      expect(call[0]).toBeGreaterThan(0);
    }

    // State untouched.
    await assertStateUntouched(env.statePath);
  });
});
