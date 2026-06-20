import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/artifacts/config.js';
import { computeDigest } from '../../src/runtime/digest.js';
import { readTaskRunResult } from '../../src/scheduler/task-run-result.js';
import { runTaskInWorktree } from '../../src/orchestrator/task-graph-worktree-runner.js';
import { TaskStatus, type ReviewLoopConfig, type TaskGraph, type TaskNode } from '../../src/types.js';

const RUN_ID = 'run-pass-path';
const TASK_ID = 'task-1';

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function makeTask(): TaskNode {
  return {
    id: TASK_ID,
    title: 'Implement feature part A',
    description: 'Add the first part of the feature under src/part-a/.',
    difficulty: 'low',
    risk: 'low',
    parallelizable: false,
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
goal_id: "goal-001"
title: "Worktree runner pass path"
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

1. The fake task passes in a worker worktree.
`;
}

function makeConfig(): ReviewLoopConfig {
  const fakeAgentPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs');
  return {
    ...DEFAULT_CONFIG,
    agents: {
      ...DEFAULT_CONFIG.agents,
      developer: {
        command: [
          'node',
          fakeAgentPath,
          '--role',
          'developer',
          '--run-id',
          '{run_id}',
          '--iteration',
          '{iteration}',
          '--project-root',
          '{project_root}',
          '--prompt-file',
          '{prompt_file}',
          '--behavior',
          'task-success',
        ],
        timeout_seconds: 60,
      },
    },
    loop: {
      ...DEFAULT_CONFIG.loop,
      max_iterations: 1,
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
  const repoDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-graph-worktree-runner-')));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  git(repoDir, ['config', 'user.email', 'test@test.com']);
  git(repoDir, ['config', 'user.name', 'Test']);

  mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export {};\n', 'utf8');

  const task = makeTask();
  const goal = makeGoal('Pass-path integration fixture.');
  const goalDigest = computeDigest(goal);
  const taskGraph: TaskGraph = {
    schema_version: 1,
    run_id: RUN_ID,
    goal_digest: goalDigest,
    created_at: '2026-06-20T12:55:32.000Z',
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
  expect(git(repoDir, ['status', '--short', '--untracked-files=all'])).toBe('');

  return { repoDir, baseCommit, task, taskGraph };
}

describe('runTaskInWorktree', () => {
  let repoDir: string | undefined;

  afterEach(() => {
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true });
      repoDir = undefined;
    }
  });

  it('runs a passing fake task in a worktree and records the task-run result', async () => {
    const fixture = createTestRepo();
    repoDir = fixture.repoDir;

    const result = await runTaskInWorktree({
      projectRoot: fixture.repoDir,
      runId: RUN_ID,
      taskGraph: fixture.taskGraph,
      task: fixture.task,
      config: makeConfig(),
      baseCommit: fixture.baseCommit,
      maxIterations: 1,
      taskIndex: 0,
      taskTotal: 1,
      slug: 'part-a',
    });

    expect(result.taskId).toBe(TASK_ID);
    expect(result.status).toBe('passed');
    expect(result.error).toBeNull();
    expect(result.branch).toBe(`agent/${RUN_ID}/${TASK_ID}-part-a`);
    expect(realpathSync(result.worktreePath)).toBe(
      realpathSync(path.join(fixture.repoDir, '.agent', 'worktrees', RUN_ID, TASK_ID)),
    );
    expect(result.finalCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.diffDigest).toMatch(/^sha256:/);
    expect(result.resultPath).toBe(path.join(fixture.repoDir, '.agent', 'task-runs', TASK_ID, 'result.json'));

    const worktreeFile = path.join(result.worktreePath, 'src', 'part-a', 'impl.ts');
    expect(existsSync(worktreeFile)).toBe(true);
    expect(readFileSync(worktreeFile, 'utf8')).toContain('export const taskFn');
    expect(existsSync(path.join(fixture.repoDir, 'src', 'part-a', 'impl.ts'))).toBe(false);

    const stored = await readTaskRunResult(fixture.repoDir, RUN_ID, TASK_ID);
    expect(stored.found).toBe(true);
    if (stored.found) {
      expect(stored.path).toBe(result.resultPath);
      expect(stored.result.task_id).toBe(result.taskId);
      expect(stored.result.status).toBe(result.status);
      expect(stored.result.error).toBe(result.error);
      expect(stored.result.branch).toBe(result.branch);
      expect(stored.result.final_commit_sha).toBe(result.finalCommitSha);
      expect(stored.result.diff_digest).toBe(result.diffDigest);
      expect(stored.result.exit_code).toBe(0);
    }

    expect(git(fixture.repoDir, ['rev-parse', '--verify', result.branch])).toBe(result.finalCommitSha);
    const committedPaths = git(fixture.repoDir, ['show', '--name-only', '--format=', result.finalCommitSha ?? '']);
    expect(committedPaths.split(/\r?\n/).filter(Boolean)).toEqual(['src/part-a/impl.ts']);

    expect(git(fixture.repoDir, ['status', '--short', '--untracked-files=all'])).toBe('');
  }, 120000);
});
