import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/artifacts/config.js';
import { computeDigest } from '../../src/runtime/digest.js';
import { Phase as PhaseEnum, TaskStatus, type ReviewLoopConfig, type TaskGraph, type TaskNode } from '../../src/types.js';

// Track calls to the mocked runTaskGraphTaskSerial.
type SerialResult = {
  passed: boolean;
  error: string | null;
  terminalResult?: {
    phase: PhaseEnum;
    message: string;
  };
};

const serialCalls: SerialResult[] = [];
const serialSpy = vi.fn(async (): Promise<SerialResult> => {
  const idx = serialSpy.mock.calls.length - 1;
  return serialCalls[idx] ?? { passed: true, error: null };
});

// Track calls to appendLog.
const appendLogSpy = vi.fn(async () => undefined);

// Track execSync calls (used by resetWorktreeToBase). Delegates to the real
// implementation so actual git reset operations still work.
const execSyncCalls: string[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('node:child_process');
  return {
    ...actual,
    execSync: (cmd: string, opts?: Parameters<typeof actual.execSync>[1]) => {
      execSyncCalls.push(cmd);
      return actual.execSync(cmd, opts);
    },
  };
});

vi.mock('../../src/orchestrator/task-graph-loop.js', () => ({
  parseGoalSuccessCriteria: () => [],
  runTaskGraphTaskSerial: (...args: unknown[]) => serialSpy(...args),
}));

vi.mock('../../src/orchestrator/run-orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    appendLog: (...args: unknown[]) => appendLogSpy(...args),
  };
});

// Import after mocks are registered.
const { runTaskInWorktree } = await import('../../src/orchestrator/task-graph-worktree-runner.js');

const RUN_ID = 'run-retry-unit';
const TASK_ID = 'task-1';

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function makeTask(): TaskNode {
  return {
    id: TASK_ID,
    title: 'Retry-feature',
    description: 'Retry behavior unit fixture.',
    difficulty: 'low',
    risk: 'low',
    parallelizable: true,
    depends_on: [],
    allowed_changes: ['src/part-a/**'],
    disallowed_changes: ['.git/**', '.agent/state.json'],
    verification_commands: [
      {
        id: 'task-1-verify',
        command: ['node', '-e', 'process.exit(0)'],
        cwd: '.',
        required: true,
        timeout_seconds: 30,
      },
    ],
    status: TaskStatus.PENDING,
  };
}

function makeGoal(goalDigestSeed: string): string {
  return `---
schema_version: 1
run_id: "${RUN_ID}"
goal_id: "goal-retry"
title: "Retry unit"
allowed_changes:
  - "src/part-a/**"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
verification_commands:
  - id: "integration"
    command: ["node", "-e", "process.exit(0)"]
    cwd: "."
    required: true
    timeout_seconds: 30
---

# Goal

${goalDigestSeed}

## Success Criteria

1. Retry unit fixture.
`;
}

function makeConfig(maxAgentRetries: number): ReviewLoopConfig {
  return {
    ...DEFAULT_CONFIG,
    agents: {
      ...DEFAULT_CONFIG.agents,
      developer: {
        command: ['node', '-e', 'process.exit(0)'],
        timeout_seconds: 60,
      },
    },
    loop: {
      ...DEFAULT_CONFIG.loop,
      max_iterations: 1,
      max_agent_retries: maxAgentRetries,
    },
    runtime: {
      ...DEFAULT_CONFIG.runtime,
      agent_idle_timeout_seconds: 30,
    },
  };
}

function createTestRepo(): {
  repoDir: string;
  baseCommit: string;
  task: TaskNode;
  taskGraph: TaskGraph;
} {
  const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'retry-unit-')));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  git(repoDir, ['config', 'user.email', 'test@test.com']);
  git(repoDir, ['config', 'user.name', 'Test']);

  mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export {};\n', 'utf8');

  const task = makeTask();
  const goal = makeGoal('Retry unit fixture.');
  const goalDigest = computeDigest(goal);
  const taskGraph: TaskGraph = {
    schema_version: 1,
    run_id: RUN_ID,
    goal_digest: goalDigest,
    created_at: '2026-06-23T07:00:00.000Z',
    tasks: [task],
  };

  const agentDir = path.join(repoDir, '.agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, 'GOAL.md'), goal, 'utf8');
  writeFileSync(path.join(agentDir, 'task-graph.json'), `${JSON.stringify(taskGraph, null, 2)}\n`, 'utf8');
  writeFileSync(
    path.join(repoDir, '.gitignore'),
    [
      '.agent/state.json',
      '.agent/run.lock',
      '.agent/iteration-log.md',
      '.agent/progress.json',
      '.agent/progress.md',
      '.agent/verification/',
      '.agent/evidence/',
      '.agent/history/',
      '.agent/debug/',
      '.agent/transcripts/',
      '.agent/task-runs/',
      '.agent/worktrees/',
      '',
    ].join('\n'),
    'utf8',
  );

  git(repoDir, ['add', 'src/index.ts', '.gitignore', '.agent/GOAL.md', '.agent/task-graph.json']);
  git(repoDir, ['commit', '-q', '-m', 'initial']);
  const baseCommit = git(repoDir, ['rev-parse', '--verify', 'HEAD']);
  return { repoDir, baseCommit, task, taskGraph };
}

describe('runTaskInWorktree retry behavior', () => {
  let repoDir: string | undefined;

  beforeEach(() => {
    serialCalls.length = 0;
    serialSpy.mockClear();
    appendLogSpy.mockClear();
  });

  afterEach(() => {
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true });
      repoDir = undefined;
    }
  });

  async function runRetry(config: ReviewLoopConfig, baseCommit: string, task: TaskNode, taskGraph: TaskGraph) {
    return runTaskInWorktree({
      projectRoot: repoDir!,
      runId: RUN_ID,
      taskGraph,
      task,
      config,
      baseCommit,
      maxIterations: 1,
      taskIndex: 0,
      taskTotal: 1,
      slug: task.title,
    });
  }

  it('retries on AGENT_ERROR then succeeds', async () => {
    const fixture = createTestRepo();
    repoDir = fixture.repoDir;
    serialCalls.push(
      { passed: false, error: 'Developer failed: Agent developer exited with code 1' },
      { passed: true, error: null },
    );

    const result = await runRetry(makeConfig(3), fixture.baseCommit, fixture.task, fixture.taskGraph);

    expect(serialSpy).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('passed');
    expect(appendLogSpy).toHaveBeenCalledTimes(1);
    expect(appendLogSpy).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      expect.any(Number),
      'DEVELOPING',
      `task ${TASK_ID} retry 1`,
      'FAIL',
      expect.stringContaining('AGENT_ERROR'),
    );
  });

  it('does NOT retry on scope violation (non-AGENT_ERROR)', async () => {
    const fixture = createTestRepo();
    repoDir = fixture.repoDir;
    serialCalls.push({ passed: false, error: 'Scope violation: src/foo.ts (outside allowed_changes)' });

    const result = await runRetry(makeConfig(3), fixture.baseCommit, fixture.task, fixture.taskGraph);

    expect(serialSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Scope violation');
    expect(appendLogSpy).not.toHaveBeenCalled();
  });

  it('does NOT retry on CANCELLED', async () => {
    const fixture = createTestRepo();
    repoDir = fixture.repoDir;
    serialCalls.push({
      passed: false,
      error: 'Run cancelled by user request',
      terminalResult: { phase: PhaseEnum.CANCELLED, message: 'Run cancelled' },
    });

    const result = await runRetry(makeConfig(3), fixture.baseCommit, fixture.task, fixture.taskGraph);

    expect(serialSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(appendLogSpy).not.toHaveBeenCalled();
  });

  it('does NOT retry when max_agent_retries = 0', async () => {
    const fixture = createTestRepo();
    repoDir = fixture.repoDir;
    serialCalls.push({ passed: false, error: 'Developer failed: Agent developer exited with code 1' });

    const result = await runRetry(makeConfig(0), fixture.baseCommit, fixture.task, fixture.taskGraph);

    expect(serialSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(appendLogSpy).not.toHaveBeenCalled();
  });

  it('resets worktree to base commit between retries', async () => {
    const fixture = createTestRepo();
    repoDir = fixture.repoDir;
    serialCalls.push(
      { passed: false, error: 'Developer failed: Agent developer exited with code 1' },
      { passed: true, error: null },
    );

    execSyncCalls.length = 0;

    await runRetry(makeConfig(3), fixture.baseCommit, fixture.task, fixture.taskGraph);

    // resetWorktreeToBase runs three git commands per retry.
    const resetCalls = execSyncCalls.filter((cmd) =>
      cmd.includes('git checkout -- .') || cmd.includes('git clean -fd') || cmd.includes('git reset --hard'),
    );
    expect(resetCalls.length).toBeGreaterThanOrEqual(3);
    expect(resetCalls.some((c) => c.includes('git checkout -- .'))).toBe(true);
    expect(resetCalls.some((c) => c.includes('git clean -fd'))).toBe(true);
    expect(resetCalls.some((c) => c.includes('git reset --hard'))).toBe(true);
    expect(resetCalls.some((c) => c.includes(fixture.baseCommit))).toBe(true);
  });

  it('exhausts all retries and returns failed', async () => {
    const fixture = createTestRepo();
    repoDir = fixture.repoDir;
    // max_agent_retries = 2 → 3 total attempts (attempt 0, 1, 2)
    for (let i = 0; i < 3; i++) {
      serialCalls.push({ passed: false, error: 'Developer failed: Agent developer exited with code 1' });
    }

    const result = await runRetry(makeConfig(2), fixture.baseCommit, fixture.task, fixture.taskGraph);

    expect(serialSpy).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('failed');
    // Error contains 'exit' (in "exited") — the AGENT_ERROR signal.
    expect(result.error).toContain('exit');
    // 2 retries logged (attempt 1 and attempt 2)
    expect(appendLogSpy).toHaveBeenCalledTimes(2);
  });

  it('succeeds on first attempt without retry', async () => {
    const fixture = createTestRepo();
    repoDir = fixture.repoDir;
    serialCalls.push({ passed: true, error: null });

    const result = await runRetry(makeConfig(3), fixture.baseCommit, fixture.task, fixture.taskGraph);

    expect(serialSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('passed');
    expect(appendLogSpy).not.toHaveBeenCalled();
  });
});
