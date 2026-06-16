import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { preflight, createTaskBranch, runGit } from '../../src/git/git-manager.js';
import { PreflightStatus } from '../../src/types.js';

describe('GitManager', () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-manager-test-'));
    const projectPath = path.join(tmpDir, 'project');
    await fs.ensureDir(projectPath);
    projectRoot = await fs.realpath(projectPath);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function initGitRepo(dir: string, withCommit = true): Promise<void> {
    await runGit(['init'], dir);
    await runGit(['config', 'user.email', 'test@test.com'], dir);
    await runGit(['config', 'user.name', 'Test'], dir);
    if (withCommit) {
      await fs.writeFile(path.join(dir, 'README.md'), '# Test');
      await runGit(['add', 'README.md'], dir);
      await runGit(['commit', '-m', 'Initial commit'], dir);
    }
  }

  describe('preflight', () => {
    it('should reject non-git directory', async () => {
      const result = await preflight(projectRoot);
      expect(result.status).toBe(PreflightStatus.ERROR);
      expect(result.error?.check).toBe('git_root');
    });

    it('should reject empty repository', async () => {
      await initGitRepo(projectRoot, false);
      const result = await preflight(projectRoot);
      expect(result.status).toBe(PreflightStatus.ERROR);
      expect(result.error?.check).toBe('no_head');
    });

    it('should reject detached HEAD', async () => {
      await initGitRepo(projectRoot);
      await runGit(['checkout', '--detach', 'HEAD'], projectRoot);

      const result = await preflight(projectRoot);
      expect(result.status).toBe(PreflightStatus.ERROR);
      expect(result.error?.check).toBe('detached_head');
    });

    it('should pass for clean repository', async () => {
      await initGitRepo(projectRoot);
      const result = await preflight(projectRoot);
      expect(result.status).toBe(PreflightStatus.OK);
      expect(result.git_root).toBe(projectRoot);
      expect(result.head_sha).toBeTruthy();
      expect(result.branch).toBe('main');
      expect(result.is_clean).toBe(true);
    });

    it('should reject dirty working tree', async () => {
      await initGitRepo(projectRoot);
      await fs.writeFile(path.join(projectRoot, 'README.md'), 'Modified');

      const result = await preflight(projectRoot);
      expect(result.status).toBe(PreflightStatus.ERROR);
      expect(result.error?.check).toBe('dirty_worktree');
    });

    it('should reject tracked agent files', async () => {
      await initGitRepo(projectRoot);
      const agentDir = path.join(projectRoot, '.agent');
      await fs.ensureDir(agentDir);
      await fs.writeFile(path.join(agentDir, 'state.json'), '{}');
      await runGit(['add', '.'], projectRoot);
      await runGit(['commit', '-m', 'Add agent file'], projectRoot);

      const result = await preflight(projectRoot);
      expect(result.status).toBe(PreflightStatus.ERROR);
      expect(result.error?.check).toBe('agent_files_tracked');
    });

    it('should handle git root mismatch', async () => {
      await initGitRepo(projectRoot);
      const subDir = path.join(projectRoot, 'subdir');
      await fs.ensureDir(subDir);

      const result = await preflight(subDir);
      expect(result.status).toBe(PreflightStatus.ERROR);
      expect(result.error?.check).toBe('git_root_mismatch');
    });
  });

  describe('createTaskBranch', () => {
    it('should create a task branch and switch to it', async () => {
      await initGitRepo(projectRoot);
      const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

      const result = await createTaskBranch(
        projectRoot,
        'run-123',
        'fix-bug',
        headResult.stdout,
        'main',
      );

      expect(result.status).toBe('created');
      expect(result.branch_name).toBe('agent/run-123-fix-bug');
      expect(result.base_commit).toBe(headResult.stdout);
      expect(result.original_branch).toBe('main');

      const branchResult = await runGit(['rev-parse', '--verify', 'agent/run-123-fix-bug'], projectRoot);
      expect(branchResult.exit_code).toBe(0);

      const currentBranch = await runGit(['branch', '--show-current'], projectRoot);
      expect(currentBranch.stdout).toBe('agent/run-123-fix-bug');
    });

    it('should reject existing branch', async () => {
      await initGitRepo(projectRoot);
      const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);
      await runGit(['branch', 'agent/run-123-fix-bug'], projectRoot);

      const result = await createTaskBranch(
        projectRoot,
        'run-123',
        'fix-bug',
        headResult.stdout,
        'main',
      );

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('STATE_CONFLICT');
    });

    it('should create branch from specific commit and switch', async () => {
      await initGitRepo(projectRoot);
      const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

      await fs.writeFile(path.join(projectRoot, 'new-file.txt'), 'content');
      await runGit(['add', 'new-file.txt'], projectRoot);
      await runGit(['commit', '-m', 'Second commit'], projectRoot);

      const result = await createTaskBranch(
        projectRoot,
        'run-123',
        'fix-bug',
        headResult.stdout,
        'main',
      );

      expect(result.status).toBe('created');
      expect(result.base_commit).toBe(headResult.stdout);

      const branchHead = await runGit(['rev-parse', 'agent/run-123-fix-bug'], projectRoot);
      expect(branchHead.stdout).toBe(headResult.stdout);

      const currentBranch = await runGit(['branch', '--show-current'], projectRoot);
      expect(currentBranch.stdout).toBe('agent/run-123-fix-bug');
    });
  });
});
