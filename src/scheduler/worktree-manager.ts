import path from 'path';
import fs from 'fs-extra';
import { runGit } from '../git/git-manager.js';

export interface WorktreeInfo {
  taskId: string;
  branch: string;
  worktreePath: string;
  baseCommit: string;
}

export class WorktreeManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeManagerError';
  }
}

export interface CreateForTaskParams {
  runId: string;
  taskId: string;
  slug: string;
  baseCommit: string;
}

interface ParsedWorktreeRecord {
  worktreePath: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
}

const WORKTREE_REF_PREFIX = 'refs/heads/';

function sanitizeBranchSegment(segment: string): string {
  return segment
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function buildBranchName(runId: string, taskId: string, slug: string): string {
  const safeRunId = sanitizeBranchSegment(runId);
  const safeTaskId = sanitizeBranchSegment(taskId);
  const safeSlug = sanitizeBranchSegment(slug);
  const tail = safeSlug.length > 0 ? `${safeTaskId}-${safeSlug}` : safeTaskId;
  return `agent/${safeRunId}/${tail}`;
}

function buildWorktreePath(projectRoot: string, runId: string, taskId: string): string {
  return path.join(projectRoot, '.agent', 'worktrees', runId, taskId);
}

function buildRunWorktreeRoot(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.agent', 'worktrees', runId);
}

function parseWorktreePorcelain(output: string): ParsedWorktreeRecord[] {
  const records: ParsedWorktreeRecord[] = [];
  if (!output) {
    return records;
  }

  const blocks = output.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const trimmed = block.replace(/\r/g, '').trim();
    if (trimmed.length === 0) {
      continue;
    }

    let worktreePath: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let detached = false;

    for (const line of trimmed.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        branch = ref.startsWith(WORKTREE_REF_PREFIX) ? ref.slice(WORKTREE_REF_PREFIX.length) : ref;
      } else if (line === 'detached') {
        detached = true;
      }
    }

    if (worktreePath !== null) {
      records.push({ worktreePath, head, branch, detached });
    }
  }

  return records;
}

async function pathsEqual(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    const realA = await fs.realpath(a);
    const realB = await fs.realpath(b);
    return realA === realB;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export class WorktreeManager {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async createForTask(params: CreateForTaskParams): Promise<{ worktreePath: string; branch: string }> {
    const { runId, taskId, slug, baseCommit } = params;
    const branch = buildBranchName(runId, taskId, slug);
    const worktreePath = buildWorktreePath(this.projectRoot, runId, taskId);

    const checkRefResult = await runGit(['check-ref-format', '--branch', branch], this.projectRoot);
    if (checkRefResult.exit_code !== 0) {
      throw new WorktreeManagerError(
        `Invalid branch name "${branch}": ${checkRefResult.stderr || 'check-ref-format rejected'}`
      );
    }

    const listResult = await runGit(['worktree', 'list', '--porcelain'], this.projectRoot);
    if (listResult.exit_code !== 0) {
      throw new WorktreeManagerError(
        `Failed to list existing worktrees: ${listResult.stderr || 'git worktree list failed'}`
      );
    }
    const existingRecords = parseWorktreePorcelain(listResult.stdout);

    for (const record of existingRecords) {
      if (await pathsEqual(record.worktreePath, worktreePath)) {
        const existingBranch = record.branch ?? branch;
        return { worktreePath: record.worktreePath, branch: existingBranch };
      }
    }

    const branchExistsResult = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], this.projectRoot);
    if (branchExistsResult.exit_code === 0) {
      throw new WorktreeManagerError(
        `Branch "${branch}" already exists but no matching worktree was found at ${worktreePath}. ` +
          `Refusing to recreate or force-remove. Inspect the branch manually before retrying.`
      );
    }

    await fs.ensureDir(path.dirname(worktreePath));

    const addResult = await runGit(
      ['worktree', 'add', '-b', branch, worktreePath, baseCommit],
      this.projectRoot
    );
    if (addResult.exit_code !== 0) {
      throw new WorktreeManagerError(
        `Failed to create worktree at ${worktreePath} for branch ${branch}: ${addResult.stderr || 'git worktree add failed'}`
      );
    }

    return { worktreePath, branch };
  }

  async cleanupTask(runId: string, taskId: string): Promise<void> {
    const worktreePath = buildWorktreePath(this.projectRoot, runId, taskId);
    try {
      const removeResult = await runGit(['worktree', 'remove', worktreePath], this.projectRoot);
      if (removeResult.exit_code !== 0) {
        return;
      }
    } catch {
      return;
    }
  }

  async prune(): Promise<void> {
    await runGit(['worktree', 'prune'], this.projectRoot);
  }

  async listForRun(runId: string): Promise<WorktreeInfo[]> {
    const listResult = await runGit(['worktree', 'list', '--porcelain'], this.projectRoot);
    if (listResult.exit_code !== 0) {
      throw new WorktreeManagerError(
        `Failed to list worktrees for run ${runId}: ${listResult.stderr || 'git worktree list failed'}`
      );
    }

    const records = parseWorktreePorcelain(listResult.stdout);
    const runRoot = buildRunWorktreeRoot(this.projectRoot, runId);
    const runRootResolved = path.resolve(runRoot);
    const infos: WorktreeInfo[] = [];

    for (const record of records) {
      const resolved = path.resolve(record.worktreePath);
      const rel = path.relative(runRootResolved, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel) || rel.length === 0) {
        continue;
      }

      const segments = rel.split(path.sep).filter((segment) => segment.length > 0);
      if (segments.length === 0) {
        continue;
      }
      const taskId = segments[0];

      infos.push({
        taskId,
        branch: record.branch ?? '',
        worktreePath: record.worktreePath,
        baseCommit: record.head ?? '',
      });
    }

    return infos;
  }
}
