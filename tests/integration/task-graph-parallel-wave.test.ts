import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';
import { readTaskRunResult } from '../../src/scheduler/task-run-result.js';

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function writeFakeAgentConfig(repoDir: string, roleBehaviors: Record<string, string>): void {
  const fakeAgentPath = resolve(join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));
  const config = {
    version: 1,
    agents: {
      planner: {
        command: ['node', fakeAgentPath, '--role', 'planner', '--run-id', '{run_id}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.planner || 'task-graph'],
        timeout_seconds: 60,
      },
      developer: {
        command: ['node', fakeAgentPath, '--role', 'developer', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.developer || 'task-success'],
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
      agent_idle_timeout_seconds: 30,
    },
  };
  writeFileSync(join(repoDir, 'review-loop.yaml'), JSON.stringify(config, null, 2), 'utf8');
}

function copyPrompts(repoDir: string): void {
  const promptsDir = join(repoDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const srcPromptsDir = join(process.cwd(), 'prompts');
  for (const fileName of ['planner.md', 'developer.md', 'auditor.md', 'final-auditor.md', 'rework.md']) {
    const source = join(srcPromptsDir, fileName);
    if (existsSync(source)) {
      copyFileSync(source, join(promptsDir, fileName));
    }
  }
}

function createTestRepo(suffix: string, roleBehaviors: Record<string, string> = {}): string {
  const repoDir = mkdtempSync(join(tmpdir(), `task-graph-parallel-wave-${suffix}-`));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  git(repoDir, ['config', 'user.email', 'test@test.com']);
  git(repoDir, ['config', 'user.name', 'Test']);

  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'task-graph-parallel-wave-test',
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"' },
  }), 'utf8');
  writeFileSync(join(repoDir, '.gitignore'), '.agent/**\n', 'utf8');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
  writeFakeAgentConfig(repoDir, roleBehaviors);
  copyPrompts(repoDir);

  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'initial']);
  expect(git(repoDir, ['status', '--short', '--untracked-files=all'])).toBe('');
  return repoDir;
}

describe('Phase 8D P5: parallel wave task-graph execution', () => {
  let repoDir: string | undefined;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ok */ }
      repoDir = undefined;
    }
  });

  it('runs a task graph through worktree-backed waves and assembles an integration branch', async () => {
    repoDir = createTestRepo('all-pass', {
      planner: 'task-graph',
      developer: 'task-success',
    });
    const originalBranch = git(repoDir, ['branch', '--show-current']);
    const originalBranchSha = git(repoDir, ['rev-parse', originalBranch]);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a multi-part feature',
      task_slug: 'parallel-wave',
      parallel: true,
      max_parallel_workers: 2,
    });

    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);
    expect(result.error).toBeNull();
    expect(result.audit_decision).toBe('PASS');
    // Phase 8E R3 creates the final project commit on integration/{run_id}.
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commit_skipped).toBe(false);
    expect(result.skip_reason).toBeNull();
    expect(result.message).toMatch(/Phase 8E R3 created the final project commit/i);
    expect(result.branch).toBe(`integration/${result.run_id}`);
    expect(git(repoDir, ['branch', '--show-current'])).toBe(`integration/${result.run_id}`);
    expect(git(repoDir, ['rev-parse', '--verify', `integration/${result.run_id}`])).toBe(result.commit_sha);
    // Original branch is not moved by R3 finalization.
    expect(git(repoDir, ['rev-parse', '--verify', originalBranch])).toBe(originalBranchSha);
    expect(result.artifact_paths).toEqual(expect.arrayContaining([
      join(repoDir, '.agent', 'integration'),
      join(repoDir, '.agent', 'integration', 'integration-plan.json'),
      join(repoDir, '.agent', 'integration', 'cherry-pick-log.jsonl'),
      join(repoDir, '.agent', 'integration', 'integrated-diff-metadata.json'),
      join(repoDir, '.agent', 'integration', 'final-audit-context.json'),
      join(repoDir, '.agent', 'final-audit.md'),
    ]));

    for (const taskId of ['task-1', 'task-2', 'task-3']) {
      const stored = await readTaskRunResult(repoDir, result.run_id, taskId);
      expect(stored.found).toBe(true);
      if (stored.found) {
        expect(stored.result.status).toBe('passed');
        expect(stored.result.branch).toBeTruthy();
        expect(stored.result.final_commit_sha).toMatch(/^[0-9a-f]{40}$/);
        expect(git(repoDir, ['rev-parse', '--verify', stored.result.branch ?? ''])).toBe(stored.result.final_commit_sha);
      }
    }

    const expectedTaskFiles = [
      'src/part-a/impl.ts',
      'src/part-b/impl.ts',
      'src/integration/impl.ts',
    ];
    for (const filePath of expectedTaskFiles) {
      expect(existsSync(join(repoDir, filePath))).toBe(true);
      expect(git(repoDir, ['show', `${result.branch}:${filePath}`])).toContain('export const taskFn');
    }

    const integrationPlan = JSON.parse(readFileSync(join(repoDir, '.agent', 'integration', 'integration-plan.json'), 'utf8'));
    expect(integrationPlan.tasks.map((entry: { task_id: string }) => entry.task_id)).toEqual(['task-1', 'task-2', 'task-3']);
    expect(integrationPlan.excluded_tasks).toEqual([]);
    expect(JSON.stringify(integrationPlan)).not.toContain('diff_digest');

    const cherryPickLog = readFileSync(join(repoDir, '.agent', 'integration', 'cherry-pick-log.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(cherryPickLog.map((entry: { outcome: string }) => entry.outcome)).toEqual(['applied', 'applied', 'applied']);
    const integratedMetadata = JSON.parse(readFileSync(join(repoDir, '.agent', 'integration', 'integrated-diff-metadata.json'), 'utf8'));
    expect(integratedMetadata.integrated_diff_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(integratedMetadata.changed_files).toEqual(expect.arrayContaining(expectedTaskFiles));

    const finalAuditContext = JSON.parse(readFileSync(join(repoDir, '.agent', 'integration', 'final-audit-context.json'), 'utf8'));
    expect(finalAuditContext.integrated_diff_digest).toBe(integratedMetadata.integrated_diff_digest);
    expect(finalAuditContext.per_task_diff_digest_reused).toBe(false);
    expect(existsSync(join(repoDir, '.agent', 'final-audit.md'))).toBe(true);

    const taskResults = JSON.parse(readFileSync(join(repoDir, '.agent', 'task-results.json'), 'utf8'));
    expect(taskResults.results.map((entry: { task_id: string }) => entry.task_id)).toEqual(['task-1', 'task-2', 'task-3']);
    expect(taskResults.results.every((entry: { status: string }) => entry.status === 'passed')).toBe(true);

    const state = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
    expect(state.phase).toBe('PASSED');
    expect(state.branch).toBe(`integration/${result.run_id}`);
    expect(state.commit_skipped).toBe(false);
    expect(state.skip_reason).toBeNull();
    expect(state.final_commit_sha).toBe(result.commit_sha);
    expect(state.audited_diff_digest).toBe(integratedMetadata.integrated_diff_digest);
    expect(Object.values(state.task_graph_state.task_statuses).every((status) => status === 'passed')).toBe(true);

    // R3 never commits .agent/task-runs/**.
    const finalTree = git(repoDir, ['ls-tree', '-r', '--name-only', result.branch]);
    expect(finalTree.split('\n').some((p) => p.startsWith('.agent/task-runs/'))).toBe(false);
  }, 120000);

  it('reports CONFIG_ERROR when wave mode is requested but the planner emits no task graph', async () => {
    repoDir = createTestRepo('no-task-graph', {
      planner: 'success',
      developer: 'task-success',
    });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Simple monolithic change',
      task_slug: 'parallel-no-task-graph',
      parallel: true,
      max_parallel_workers: 2,
      no_commit: true,
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
    expect(result.error?.code).toBe('CONFIG_ERROR');
    expect(result.message).toMatch(/requires task-graph planning/i);
    expect(result.message).not.toMatch(/Round 2E/);
  }, 120000);
});
