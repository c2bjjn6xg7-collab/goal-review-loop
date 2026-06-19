/**
 * Regression tests for the `--no-commit` finalization bypass.
 *
 * Bug: `src/cli/start.ts` read `options.noCommit`, but Commander v15 maps
 * `--no-commit` to `options.commit = false`. The mismatch caused
 * `no_commit: undefined` to flow into the orchestrator, which then fell
 * back to `!config.git.commit_on_pass` (false by default), so a commit
 * was created on PASS despite `--no-commit`.
 *
 * Coverage:
 * 1. Commander option parsing populates `commit: false` for `--no-commit`.
 * 2. `executeStart` with `commit: false` reaches PASSED with no commit
 *    (HEAD unchanged from the initial commit).
 * 3. `executeStart` default (no flag) reaches PASSED with a commit
 *    (HEAD advances) — sanity baseline.
 * 4. Task-graph finalization honors `no_commit` end-to-end (HEAD unchanged).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';
import { createStartCommand, executeStart } from '../../src/cli/start.js';

function writeFakeAgentConfig(repoDir: string, roleBehaviors: Record<string, string>): void {
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

function createTestRepo(suffix: string, roleBehaviors: Record<string, string> = {}): string {
  const repoDir = join(tmpdir(), `no-commit-bypass-${suffix}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email test@test.com', { cwd: repoDir });
  execSync('git config user.name test', { cwd: repoDir });

  writeFileSync(join(repoDir, 'README.md'), '# Test\n');
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'no-commit-bypass-test',
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

function head(repoDir: string): string {
  return execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
}

function commitCount(repoDir: string): number {
  const out = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' }).trim();
  return out ? out.split('\n').length : 0;
}

describe('--no-commit bypass regression', () => {
  let repoDir: string;
  const originalCwd = process.cwd();

  afterEach(() => {
    // Always restore cwd before cleanup so tmpdir removal doesn't fail.
    try { process.chdir(originalCwd); } catch { /* ok */ }
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('Commander parses --no-commit as { commit: false }', () => {
    // Override the action so parse() doesn't fire the orchestrator path,
    // which would call process.exit and pollute the test runner.
    const cmd = createStartCommand();
    cmd.exitOverride();
    cmd.action(() => { /* no-op for option-parsing test */ });
    cmd.parse(['--request', 'noop', '--no-commit'], { from: 'user' });
    expect(cmd.opts().commit).toBe(false);

    const cmd2 = createStartCommand();
    cmd2.exitOverride();
    cmd2.action(() => { /* no-op */ });
    cmd2.parse(['--request', 'noop'], { from: 'user' });
    expect(cmd2.opts().commit).toBe(true);

    // Phase 8D P5 Round 2B: Commander parses --parallel and
    // --max-parallel-workers <n> into the new StartOptions fields. The strict
    // worker parser yields a real number, not a string.
    const cmd3 = createStartCommand();
    cmd3.exitOverride();
    cmd3.action(() => { /* no-op */ });
    cmd3.parse(['--request', 'noop', '--parallel', '--max-parallel-workers', '3'], { from: 'user' });
    expect(cmd3.opts().parallel).toBe(true);
    expect(cmd3.opts().maxParallelWorkers).toBe(3);
  });

  it('executeStart({ commit: false }) reaches PASSED with no commit (HEAD unchanged)', async () => {
    repoDir = createTestRepo('cli-no-commit');
    const headBefore = head(repoDir);
    const countBefore = commitCount(repoDir);

    process.chdir(repoDir);
    const result = await executeStart({
      request: 'Add feature',
      taskSlug: 'cli-no-commit',
      commit: false,
    });

    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);
    expect(result.commit_skipped).toBe(true);
    expect(result.commit_sha).toBeNull();
    expect(result.skip_reason).toBe('--no-commit');

    // HEAD must be unchanged from the initial commit on the agent branch.
    // After branch creation, HEAD still points to the same commit until a real
    // commit is made. We assert HEAD has not advanced.
    expect(head(repoDir)).toBe(headBefore);
    expect(commitCount(repoDir)).toBe(countBefore);
  }, 120000);

  it('executeStart({}) default reaches PASSED with a commit (HEAD advances)', async () => {
    repoDir = createTestRepo('cli-default-commit');
    const headBefore = head(repoDir);
    const countBefore = commitCount(repoDir);

    process.chdir(repoDir);
    // Commander default: when --no-commit is not passed, options.commit === true.
    const result = await executeStart({
      request: 'Add feature',
      taskSlug: 'cli-default-commit',
      commit: true,
    });

    expect(result.phase).toBe('PASSED');
    expect(result.commit_sha).toBeTruthy();
    expect(result.commit_skipped).toBe(false);

    // HEAD advanced and a new commit exists on top of the initial commit.
    expect(head(repoDir)).not.toBe(headBefore);
    expect(commitCount(repoDir)).toBe(countBefore + 1);
  }, 120000);

  it('task-graph runs honor no_commit (HEAD unchanged across all tasks)', async () => {
    repoDir = createTestRepo('task-graph-no-commit', {
      planner: 'task-graph',
      developer: 'task-success',
    });
    const headBefore = head(repoDir);
    const countBefore = commitCount(repoDir);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a multi-part feature',
      task_slug: 'tg-no-commit',
      no_commit: true,
    });

    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);
    expect(result.commit_skipped).toBe(true);
    expect(result.commit_sha).toBeNull();
    expect(result.skip_reason).toBe('--no-commit');

    // No commit was created by either the per-task path or finalization.
    expect(head(repoDir)).toBe(headBefore);
    expect(commitCount(repoDir)).toBe(countBefore);
  }, 180000);
});
