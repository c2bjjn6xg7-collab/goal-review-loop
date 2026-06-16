import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { PreflightStatus, type PreflightResult, type TaskBranchResult } from '../types.js';
import { runProcess, runProcessRaw } from '../runtime/process-runner.js';

export class GitManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitManagerError';
  }
}

const AGENT_TRACKED_PATTERNS = [
  '.agent/state.json',
  '.agent/run.lock',
  '.agent/iteration-log.md',
  '.agent/verification/**',
  '.agent/evidence/**',
  '.agent/history/**',
  '.agent/debug/**',
];

function normalizeBranchName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9-_/]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const tmpDir = path.join(os.tmpdir(), `git-runner-${process.pid}`);
  await fs.ensureDir(tmpDir);

  const stdoutPath = path.join(tmpDir, `git-stdout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
  const stderrPath = path.join(tmpDir, `git-stderr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);

  try {
    const result = await runProcess({
      argv: ['git', ...args],
      cwd,
      timeout_ms: 30000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    }, cwd);

    const stdout = await fs.readFile(stdoutPath, 'utf8').catch(() => '');
    const stderr = await fs.readFile(stderrPath, 'utf8').catch(() => '');

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exit_code: result.exit_code ?? -1,
    };
  } finally {
    await fs.remove(stdoutPath).catch(() => {});
    await fs.remove(stderrPath).catch(() => {});
  }
}

export async function runGitRaw(args: string[], cwd: string): Promise<{ stdout: Buffer; stderr: string; exit_code: number }> {
  const tmpDir = path.join(os.tmpdir(), `git-runner-${process.pid}`);
  await fs.ensureDir(tmpDir);

  const stdoutPath = path.join(tmpDir, `git-stdout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
  const stderrPath = path.join(tmpDir, `git-stderr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);

  try {
    const result = await runProcessRaw({
      argv: ['git', ...args],
      cwd,
      timeout_ms: 30000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    }, cwd);

    const stdout = await fs.readFile(stdoutPath).catch(() => Buffer.alloc(0));
    const stderr = await fs.readFile(stderrPath, 'utf8').catch(() => '');

    return {
      stdout,
      stderr: stderr.trim(),
      exit_code: result.exit_code ?? -1,
    };
  } finally {
    await fs.remove(stdoutPath).catch(() => {});
    await fs.remove(stderrPath).catch(() => {});
  }
}

export async function preflight(projectRoot: string): Promise<PreflightResult> {
  const error = (check: string, message: string): PreflightResult => ({
    status: PreflightStatus.ERROR,
    git_root: null,
    head_sha: null,
    branch: null,
    is_clean: null,
    tracked_agent_files: [],
    error: { code: 'PREFLIGHT_ERROR', message, check },
  });

  const realProjectRoot = await fs.realpath(projectRoot);

  const gitRootResult = await runGit(['rev-parse', '--show-toplevel'], projectRoot);
  if (gitRootResult.exit_code !== 0) {
    return error('git_root', 'Not a git repository');
  }

  const gitRoot = await fs.realpath(gitRootResult.stdout);
  if (gitRoot !== realProjectRoot) {
    return error('git_root_mismatch', `Git root (${gitRoot}) does not match project root (${realProjectRoot})`);
  }

  const headResult = await runGit(['rev-parse', '--verify', 'HEAD'], projectRoot);
  if (headResult.exit_code !== 0) {
    return error('no_head', 'Repository has no HEAD (empty repository)');
  }
  const headSha = headResult.stdout;

  const branchResult = await runGit(['branch', '--show-current'], projectRoot);
  if (branchResult.exit_code !== 0 || !branchResult.stdout) {
    return error('detached_head', 'HEAD is detached');
  }
  const branch = branchResult.stdout;

  const statusResult = await runGit(['status', '--porcelain=v1', '-uall'], projectRoot);
  if (statusResult.exit_code !== 0) {
    return error('status_failed', 'Failed to get git status');
  }

  const lsFilesResult = await runGit(['ls-files'], projectRoot);
  if (lsFilesResult.exit_code !== 0) {
    return error('ls_files_failed', 'Failed to list tracked files');
  }

  const trackedFiles = lsFilesResult.stdout.split('\n').filter((line) => line.length > 0);
  const trackedAgentFiles: string[] = [];

  for (const filePath of trackedFiles) {
    if (AGENT_TRACKED_PATTERNS.some((pattern) => {
      if (pattern.endsWith('**')) {
        return filePath.startsWith(pattern.slice(0, -2));
      }
      return filePath === pattern;
    })) {
      trackedAgentFiles.push(filePath);
    }
  }

  if (trackedAgentFiles.length > 0) {
    return error('agent_files_tracked', `Agent runtime files are tracked: ${trackedAgentFiles.join(', ')}`);
  }

  const statusLines = statusResult.stdout.split('\n').filter((line) => line.length > 0);
  const isClean = statusLines.length === 0;

  if (!isClean) {
    return error('dirty_worktree', 'Working tree is not clean. Commit or stash changes before starting a task.');
  }

  return {
    status: PreflightStatus.OK,
    git_root: realProjectRoot,
    head_sha: headSha,
    branch,
    is_clean: isClean,
    tracked_agent_files: [],
  };
}

export async function createTaskBranch(
  projectRoot: string,
  runId: string,
  taskSlug: string,
  baseCommit: string,
  originalBranch: string,
  branchTemplate: string = 'agent/{run_id}-{task_slug}',
): Promise<TaskBranchResult> {
  const normalizedRunId = normalizeBranchName(runId);
  const normalizedTaskSlug = normalizeBranchName(taskSlug);

  const branchName = branchTemplate
    .replace('{run_id}', normalizedRunId)
    .replace('{task_slug}', normalizedTaskSlug);

  const checkResult = await runGit(['check-ref-format', '--branch', branchName], projectRoot);
  if (checkResult.exit_code !== 0) {
    return {
      status: 'error',
      branch_name: branchName,
      base_commit: baseCommit,
      original_branch: originalBranch,
      error: {
        code: 'PREFLIGHT_ERROR',
        message: `Invalid branch name: ${branchName}`,
      },
    };
  }

  const existingResult = await runGit(['rev-parse', '--verify', branchName], projectRoot);
  if (existingResult.exit_code === 0) {
    return {
      status: 'error',
      branch_name: branchName,
      base_commit: baseCommit,
      original_branch: originalBranch,
      error: {
        code: 'STATE_CONFLICT',
        message: `Branch already exists: ${branchName}`,
      },
    };
  }

  const createResult = await runGit(['switch', '-c', branchName, baseCommit], projectRoot);
  if (createResult.exit_code !== 0) {
    return {
      status: 'error',
      branch_name: branchName,
      base_commit: baseCommit,
      original_branch: originalBranch,
      error: {
        code: 'PREFLIGHT_ERROR',
        message: `Failed to create and switch to branch: ${createResult.stderr}`,
      },
    };
  }

  const verifyResult = await runGit(['branch', '--show-current'], projectRoot);
  if (verifyResult.stdout !== branchName) {
    return {
      status: 'error',
      branch_name: branchName,
      base_commit: baseCommit,
      original_branch: originalBranch,
      error: {
        code: 'PREFLIGHT_ERROR',
        message: `Branch switch verification failed: expected ${branchName}, got ${verifyResult.stdout}`,
      },
    };
  }

  return {
    status: 'created',
    branch_name: branchName,
    base_commit: baseCommit,
    original_branch: originalBranch,
  };
}
