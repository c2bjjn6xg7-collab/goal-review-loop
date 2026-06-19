import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorktreeManager } from '../../src/scheduler/worktree-manager.js';
import { runGit } from '../../src/git/git-manager.js';

interface TestRepo {
  repoDir: string;
  baseSha: string;
}

function createTestRepo(suffix: string): TestRepo {
  const rawRepoDir = join(
    tmpdir(),
    `wt-mgr-test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(rawRepoDir, { recursive: true });
  const repoDir = realpathSync(rawRepoDir);
  execSync('git init -q', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# Test\n');
  execSync('git add -A && git commit -q -m "initial"', { cwd: repoDir });
  const baseSha = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim();
  return { repoDir, baseSha };
}

let cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  cleanupDirs = [];
});

describe('WorktreeManager.createForTask', () => {
  it('creates a worktree and branch at the requested base commit', async () => {
    const { repoDir, baseSha } = createTestRepo('create');
    cleanupDirs.push(repoDir);
    const mgr = new WorktreeManager(repoDir);

    const result = await mgr.createForTask({
      runId: 'run-001',
      taskId: 't1',
      slug: 'demo',
      baseCommit: baseSha,
    });

    expect(result.branch).toBe('agent/run-001/t1-demo');
    const expectedPath = join(repoDir, '.agent', 'worktrees', 'run-001', 't1');
    expect(realpathSync(result.worktreePath)).toBe(realpathSync(expectedPath));
    expect(existsSync(result.worktreePath)).toBe(true);

    const branchShaResult = await runGit(
      ['rev-parse', `refs/heads/${result.branch}`],
      repoDir,
    );
    expect(branchShaResult.exit_code).toBe(0);
    expect(branchShaResult.stdout).toBe(baseSha);
  });

  it('is idempotent for repeated calls with the same run/task', async () => {
    const { repoDir, baseSha } = createTestRepo('idem');
    cleanupDirs.push(repoDir);
    const mgr = new WorktreeManager(repoDir);

    const params = {
      runId: 'run-002',
      taskId: 't1',
      slug: 'demo',
      baseCommit: baseSha,
    };

    const first = await mgr.createForTask(params);
    const second = await mgr.createForTask(params);

    expect(realpathSync(second.worktreePath)).toBe(realpathSync(first.worktreePath));
    expect(second.branch).toBe(first.branch);
    expect(existsSync(second.worktreePath)).toBe(true);

    // Only one worktree record under .agent/worktrees/run-002/
    const list = await mgr.listForRun('run-002');
    expect(list.length).toBe(1);
    expect(list[0].taskId).toBe('t1');
  });
});

describe('WorktreeManager.cleanupTask', () => {
  it('removes the worktree path but keeps the branch for cherry-picking', async () => {
    const { repoDir, baseSha } = createTestRepo('cleanup-keep-branch');
    cleanupDirs.push(repoDir);
    const mgr = new WorktreeManager(repoDir);

    const created = await mgr.createForTask({
      runId: 'run-003',
      taskId: 't1',
      slug: 'demo',
      baseCommit: baseSha,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    await mgr.cleanupTask('run-003', 't1');

    expect(existsSync(created.worktreePath)).toBe(false);
    const branchCheck = await runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${created.branch}`],
      repoDir,
    );
    expect(branchCheck.exit_code).toBe(0);
    expect(branchCheck.stdout).toBe(baseSha);
  });

  it('is non-fatal when removal fails because the worktree is missing', async () => {
    const { repoDir, baseSha } = createTestRepo('cleanup-nonfatal');
    cleanupDirs.push(repoDir);
    const mgr = new WorktreeManager(repoDir);

    const created = await mgr.createForTask({
      runId: 'run-004',
      taskId: 't1',
      slug: 'demo',
      baseCommit: baseSha,
    });

    // Removing a task that was never created → git worktree remove fails non-zero.
    await expect(
      mgr.cleanupTask('run-004', 'never-existed-task'),
    ).resolves.toBeUndefined();

    // Original branch must not be touched by a failed cleanup call.
    const realBranch = await runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${created.branch}`],
      repoDir,
    );
    expect(realBranch.exit_code).toBe(0);

    // Cleanup is also idempotent: removing the same task twice does not throw.
    await mgr.cleanupTask('run-004', 't1');
    await expect(mgr.cleanupTask('run-004', 't1')).resolves.toBeUndefined();

    const branchAfter = await runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${created.branch}`],
      repoDir,
    );
    expect(branchAfter.exit_code).toBe(0);
  });
});

describe('WorktreeManager.prune', () => {
  it('removes stale worktree metadata after the directory is removed manually', async () => {
    const { repoDir, baseSha } = createTestRepo('prune');
    cleanupDirs.push(repoDir);
    const mgr = new WorktreeManager(repoDir);

    const created = await mgr.createForTask({
      runId: 'run-005',
      taskId: 't1',
      slug: 'demo',
      baseCommit: baseSha,
    });

    rmSync(created.worktreePath, { recursive: true, force: true });

    const beforeList = await runGit(['worktree', 'list', '--porcelain'], repoDir);
    expect(beforeList.exit_code).toBe(0);
    expect(beforeList.stdout).toContain(created.worktreePath);

    await mgr.prune();

    const afterList = await runGit(['worktree', 'list', '--porcelain'], repoDir);
    expect(afterList.exit_code).toBe(0);
    expect(afterList.stdout).not.toContain(created.worktreePath);
  });
});

describe('WorktreeManager.listForRun', () => {
  it('returns only worktrees for the requested run', async () => {
    const { repoDir, baseSha } = createTestRepo('list');
    cleanupDirs.push(repoDir);
    const mgr = new WorktreeManager(repoDir);

    await mgr.createForTask({
      runId: 'run-A',
      taskId: 't1',
      slug: 'first',
      baseCommit: baseSha,
    });
    await mgr.createForTask({
      runId: 'run-A',
      taskId: 't2',
      slug: 'second',
      baseCommit: baseSha,
    });
    await mgr.createForTask({
      runId: 'run-B',
      taskId: 't1',
      slug: 'third',
      baseCommit: baseSha,
    });

    const aList = await mgr.listForRun('run-A');
    expect(aList.length).toBe(2);

    const aTaskIds = aList.map((info) => info.taskId).sort();
    expect(aTaskIds).toEqual(['t1', 't2']);

    for (const info of aList) {
      expect(info.branch.startsWith('agent/run-A/')).toBe(true);
      expect(info.baseCommit).toBe(baseSha);
      expect(info.worktreePath).toContain(join('.agent', 'worktrees', 'run-A'));
    }

    const bList = await mgr.listForRun('run-B');
    expect(bList.length).toBe(1);
    expect(bList[0].taskId).toBe('t1');
    expect(bList[0].branch).toBe('agent/run-B/t1-third');

    // Excludes the original repo (which is not under .agent/worktrees/{runId}/).
    const cList = await mgr.listForRun('run-does-not-exist');
    expect(cList.length).toBe(0);
  });
});
