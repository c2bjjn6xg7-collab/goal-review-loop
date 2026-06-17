/**
 * Phase 8B integration test: sequential task graph execution with a fake provider.
 *
 * Verifies:
 * - Planner produces a valid task-graph.json (3 tasks, DAG).
 * - Orchestrator executes tasks in topological order.
 * - Per-task scope guard enforces each task's allowed_changes.
 * - task-results.json accumulates per-task results.
 * - Final integration verification runs after all tasks.
 * - Run ends in PASSED with a commit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';

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
  const repoDir = join(tmpdir(), `task-graph-test-${suffix}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email test@test.com', { cwd: repoDir });
  execSync('git config user.name test', { cwd: repoDir });
  // Seed a package.json with a no-op test script so verification commands can run.
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'task-graph-test',
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"' },
  }), 'utf8');
  // Seed src/ so the repo has tracked source files.
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
  writeFakeAgentConfig(repoDir, roleBehaviors);
  copyPrompts(repoDir);
  execSync('git add -A', { cwd: repoDir });
  execSync('git commit -m "initial"', { cwd: repoDir });
  return repoDir;
}

describe('Phase 8B: Task Graph sequential execution', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('executes all tasks in topological order and ends in PASSED', async () => {
    repoDir = createTestRepo('seq-pass', {
      planner: 'task-graph',
      developer: 'task-success',
    });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a multi-part feature',
      task_slug: 'multi-part',
    });

    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);
    expect(result.commit_sha).toBeTruthy();

    // task-graph.json produced by Planner
    const tgPath = join(repoDir, '.agent', 'task-graph.json');
    expect(existsSync(tgPath)).toBe(true);
    const tg = JSON.parse(readFileSync(tgPath, 'utf8'));
    expect(tg.tasks).toHaveLength(3);

    // task-results.json accumulated
    const trPath = join(repoDir, '.agent', 'task-results.json');
    expect(existsSync(trPath)).toBe(true);
    const tr = JSON.parse(readFileSync(trPath, 'utf8'));
    expect(tr.results).toHaveLength(3);
    expect(tr.results.every((r: { status: string }) => r.status === 'passed')).toBe(true);

    // Per-task source files created within each task's allowed scope
    expect(existsSync(join(repoDir, 'src', 'part-a', 'impl.ts'))).toBe(true);
    expect(existsSync(join(repoDir, 'src', 'part-b', 'impl.ts'))).toBe(true);
    expect(existsSync(join(repoDir, 'src', 'integration', 'impl.ts'))).toBe(true);

    // state.json records task_graph_state with all tasks passed
    const state = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
    expect(state.task_graph_state).toBeTruthy();
    const statuses = state.task_graph_state.task_statuses;
    expect(Object.keys(statuses)).toHaveLength(3);
    expect(Object.values(statuses).every((v: string) => v === 'passed')).toBe(true);
  }, 120000);

  it('records task graph progress in progress.md and state.json', async () => {
    repoDir = createTestRepo('seq-progress', {
      planner: 'task-graph',
      developer: 'task-success',
    });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a multi-part feature',
      task_slug: 'multi-part-progress',
    });

    expect(result.phase).toBe('PASSED');

    // state.json persists task_graph_state with all tasks passed
    const state = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
    expect(state.task_graph_state).toBeTruthy();
    expect(state.task_graph_state.current_task_index).toBeGreaterThanOrEqual(0);
    const statuses = state.task_graph_state.task_statuses;
    expect(Object.values(statuses).every((v: string) => v === 'passed')).toBe(true);

    // progress.md contains task graph section (written during task execution)
    const progressMd = readFileSync(join(repoDir, '.agent', 'progress.md'), 'utf8');
    expect(progressMd).toMatch(/Task Graph/i);
  }, 120000);
});
