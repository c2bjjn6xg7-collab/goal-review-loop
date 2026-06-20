import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runIntegrationMerge } from '../../src/orchestrator/integration-runner.js';
import type { IntegrationPlan } from '../../src/orchestrator/integration-plan.js';

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function createRepo(prefix: string): { repoDir: string; baseCommit: string; mainBranch: string } {
  const repoDir = mkdtempSync(path.join(tmpdir(), `integration-runner-${prefix}-`));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  git(repoDir, ['config', 'user.email', 'test@test.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  writeFile(repoDir, 'README.md', '# Test\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-q', '-m', 'initial']);
  return {
    repoDir,
    baseCommit: git(repoDir, ['rev-parse', '--verify', 'HEAD']),
    mainBranch: git(repoDir, ['branch', '--show-current']),
  };
}

function writeFile(repoDir: string, relativePath: string, content: string): void {
  mkdirSync(path.dirname(path.join(repoDir, relativePath)), { recursive: true });
  writeFileSync(path.join(repoDir, relativePath), content, 'utf8');
}

function createTaskCommit(params: {
  repoDir: string;
  baseCommit: string;
  returnBranch: string;
  branch: string;
  filePath: string;
  content: string;
  message: string;
}): string {
  git(params.repoDir, ['switch', '-c', params.branch, params.baseCommit]);
  writeFile(params.repoDir, params.filePath, params.content);
  git(params.repoDir, ['add', params.filePath]);
  git(params.repoDir, ['commit', '-q', '-m', params.message]);
  const sha = git(params.repoDir, ['rev-parse', '--verify', 'HEAD']);
  git(params.repoDir, ['switch', params.returnBranch]);
  return sha;
}

function makePlan(overrides: Partial<IntegrationPlan> = {}): IntegrationPlan {
  return {
    schema_version: 1,
    run_id: 'run-integration',
    base_commit: 'base',
    integration_branch: 'integration/run-integration',
    tasks: [],
    excluded_tasks: [],
    partial: false,
    created_at: '2026-06-20T00:00:00.000Z',
    ...overrides,
  };
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('runIntegrationMerge', () => {
  let repoDir: string | undefined;

  afterEach(() => {
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true });
      repoDir = undefined;
    }
  });

  it('creates integration branch from base commit and cherry-picks clean task commits', async () => {
    const repo = createRepo('clean');
    repoDir = repo.repoDir;
    const first = createTaskCommit({
      repoDir: repo.repoDir,
      baseCommit: repo.baseCommit,
      returnBranch: repo.mainBranch,
      branch: 'agent/run-integration/task-1',
      filePath: 'src/part-a.ts',
      content: 'export const partA = true;\n',
      message: 'task 1',
    });
    const second = createTaskCommit({
      repoDir: repo.repoDir,
      baseCommit: repo.baseCommit,
      returnBranch: repo.mainBranch,
      branch: 'agent/run-integration/task-2',
      filePath: 'src/part-b.ts',
      content: 'export const partB = true;\n',
      message: 'task 2',
    });
    const plan = makePlan({
      base_commit: repo.baseCommit,
      tasks: [
        { task_id: 'task-1', branch: 'agent/run-integration/task-1', commit_sha: first, status: 'passed' },
        { task_id: 'task-2', branch: 'agent/run-integration/task-2', commit_sha: second, status: 'passed' },
      ],
    });

    const result = await runIntegrationMerge({
      projectRoot: repo.repoDir,
      runId: plan.run_id,
      baseCommit: repo.baseCommit,
      plan,
    });

    expect(result.status).toBe('passed');
    expect(result.integration_branch).toBe('integration/run-integration');
    expect(result.applied_tasks).toEqual(['task-1', 'task-2']);
    expect(result.skipped_tasks).toEqual([]);
    expect(git(repo.repoDir, ['branch', '--show-current'])).toBe('integration/run-integration');
    expect(readFileSync(path.join(repo.repoDir, 'src/part-a.ts'), 'utf8')).toContain('partA');
    expect(readFileSync(path.join(repo.repoDir, 'src/part-b.ts'), 'utf8')).toContain('partB');
    expect(git(repo.repoDir, ['merge-base', '--is-ancestor', repo.baseCommit, 'integration/run-integration'])).toBe('');

    const artifactDir = path.join(repo.repoDir, '.agent', 'integration');
    expect(JSON.parse(readFileSync(path.join(artifactDir, 'integration-plan.json'), 'utf8'))).toMatchObject({
      run_id: 'run-integration',
      integration_branch: 'integration/run-integration',
    });
    expect(readJsonl(path.join(artifactDir, 'cherry-pick-log.jsonl')).map((entry) => entry.outcome)).toEqual(['applied', 'applied']);
    expect(result.artifact_paths).toContain(path.join(artifactDir, 'integration-plan.json'));
    expect(result.artifact_paths).toContain(path.join(artifactDir, 'cherry-pick-log.jsonl'));
  });

  it('skips already-applied task commits on rerun', async () => {
    const repo = createRepo('rerun');
    repoDir = repo.repoDir;
    const commit = createTaskCommit({
      repoDir: repo.repoDir,
      baseCommit: repo.baseCommit,
      returnBranch: repo.mainBranch,
      branch: 'agent/run-integration/task-1',
      filePath: 'src/part-a.ts',
      content: 'export const partA = true;\n',
      message: 'task 1',
    });
    const plan = makePlan({
      base_commit: repo.baseCommit,
      tasks: [
        { task_id: 'task-1', branch: 'agent/run-integration/task-1', commit_sha: commit, status: 'passed' },
      ],
    });

    const first = await runIntegrationMerge({ projectRoot: repo.repoDir, runId: plan.run_id, baseCommit: repo.baseCommit, plan });
    const headAfterFirst = git(repo.repoDir, ['rev-parse', '--verify', 'HEAD']);
    const second = await runIntegrationMerge({ projectRoot: repo.repoDir, runId: plan.run_id, baseCommit: repo.baseCommit, plan });
    const headAfterSecond = git(repo.repoDir, ['rev-parse', '--verify', 'HEAD']);

    expect(first.status).toBe('passed');
    expect(first.applied_tasks).toEqual(['task-1']);
    expect(second.status).toBe('passed');
    expect(second.applied_tasks).toEqual([]);
    expect(second.skipped_tasks).toEqual(['task-1']);
    expect(headAfterSecond).toBe(headAfterFirst);
    const logPath = path.join(repo.repoDir, '.agent', 'integration', 'cherry-pick-log.jsonl');
    expect(readJsonl(logPath).map((entry) => entry.outcome)).toEqual(['already_applied']);
  });

  it('writes a conflict report, aborts cherry-pick, and returns blocked on conflict', async () => {
    const repo = createRepo('conflict');
    repoDir = repo.repoDir;
    writeFile(repo.repoDir, 'src/shared.ts', 'export const value = "base";\n');
    git(repo.repoDir, ['add', 'src/shared.ts']);
    git(repo.repoDir, ['commit', '-q', '-m', 'add shared']);
    const baseCommit = git(repo.repoDir, ['rev-parse', '--verify', 'HEAD']);

    const first = createTaskCommit({
      repoDir: repo.repoDir,
      baseCommit,
      returnBranch: repo.mainBranch,
      branch: 'agent/run-conflict/task-1',
      filePath: 'src/shared.ts',
      content: 'export const value = "task-1";\n',
      message: 'task 1',
    });
    const second = createTaskCommit({
      repoDir: repo.repoDir,
      baseCommit,
      returnBranch: repo.mainBranch,
      branch: 'agent/run-conflict/task-2',
      filePath: 'src/shared.ts',
      content: 'export const value = "task-2";\n',
      message: 'task 2',
    });
    const plan = makePlan({
      run_id: 'run-conflict',
      base_commit: baseCommit,
      integration_branch: 'integration/run-conflict',
      tasks: [
        { task_id: 'task-1', branch: 'agent/run-conflict/task-1', commit_sha: first, status: 'passed' },
        { task_id: 'task-2', branch: 'agent/run-conflict/task-2', commit_sha: second, status: 'passed' },
      ],
    });

    const result = await runIntegrationMerge({ projectRoot: repo.repoDir, runId: plan.run_id, baseCommit, plan });

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('VERIFICATION_FAILED');
    expect(result.error_message).toMatch(/Cherry-pick conflict/);
    expect(git(repo.repoDir, ['branch', '--show-current'])).toBe('integration/run-conflict');
    expect(git(repo.repoDir, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
    expect(readFileSync(path.join(repo.repoDir, 'src/shared.ts'), 'utf8')).toBe('export const value = "task-1";\n');
    expect(readFileSync(path.join(repo.repoDir, 'src/shared.ts'), 'utf8')).not.toContain('<<<<<<<');

    const reportPath = path.join(repo.repoDir, '.agent', 'integration', 'conflict-report.md');
    expect(existsSync(reportPath)).toBe(true);
    const report = readFileSync(reportPath, 'utf8');
    expect(report).toContain('Task ID: task-2');
    expect(report).toContain('src/shared.ts');
    expect(report).toContain('cherry_pick_conflict');
    expect(readJsonl(path.join(repo.repoDir, '.agent', 'integration', 'cherry-pick-log.jsonl')).map((entry) => entry.outcome)).toEqual(['applied', 'conflict']);
  });

  it('blocks when an existing integration branch is not descended from base commit', async () => {
    const repo = createRepo('state-conflict');
    repoDir = repo.repoDir;
    git(repo.repoDir, ['switch', '--orphan', 'integration/run-integration']);
    rmSync(path.join(repo.repoDir, 'README.md'), { force: true });
    writeFile(repo.repoDir, 'ORPHAN.md', 'orphan\n');
    git(repo.repoDir, ['add', '-A']);
    git(repo.repoDir, ['commit', '-q', '-m', 'orphan integration']);
    git(repo.repoDir, ['switch', repo.mainBranch]);
    const plan = makePlan({ base_commit: repo.baseCommit });

    const result = await runIntegrationMerge({
      projectRoot: repo.repoDir,
      runId: plan.run_id,
      baseCommit: repo.baseCommit,
      plan,
    });

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('STATE_CONFLICT');
    expect(result.error_message).toContain('not a descendant');
    expect(git(repo.repoDir, ['branch', '--show-current'])).toBe(repo.mainBranch);
  });
});
