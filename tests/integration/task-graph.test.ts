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

function writeFakeAgentConfig(
  repoDir: string,
  roleBehaviors: Record<string, string>,
  runtimeOverrides?: Record<string, number>,
): void {
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
      ...runtimeOverrides,
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

function createTestRepo(
  suffix: string,
  roleBehaviors: Record<string, string> = {},
  runtimeOverrides?: Record<string, number>,
): string {
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
  writeFakeAgentConfig(repoDir, roleBehaviors, runtimeOverrides);
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
    // Task results must be in topological order: task-1, task-2, task-3.
    expect(tr.results.map((r: { task_id: string }) => r.task_id)).toEqual(['task-1', 'task-2', 'task-3']);
    // Each task should pass on the first attempt with the success behavior.
    expect(tr.results.map((r: { attempts: number }) => r.attempts)).toEqual([1, 1, 1]);
    // Per-task verification must pass for every task.
    expect(tr.results.every((r: { verification_passed: boolean }) => r.verification_passed === true)).toBe(true);

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

// ─── Resume: BLOCKED on a task records the failed task index ──
describe('Phase 8B: Task Graph resume', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('records current_task_index pointing at the failed task on BLOCKED', async () => {
    repoDir = createTestRepo('seq-blocked', {
      planner: 'task-graph',
      developer: 'blocked-handoff',
    });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a multi-part feature',
      task_slug: 'multi-blocked',
      max_iterations: 2,
    });

    expect(result.phase).toBe('BLOCKED');

    // state.json must record task_graph_state with current_task_index = 0
    // (task-1 is the first task and the developer blocks on it).
    const state = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
    expect(state.task_graph_state).toBeTruthy();
    expect(state.task_graph_state.current_task_index).toBe(0);
    expect(state.task_graph_state.task_statuses['task-1']).toBe('failed');
    // task-2 and task-3 should remain pending (not yet attempted)
    expect(state.task_graph_state.task_statuses['task-2']).toBe('pending');
    expect(state.task_graph_state.task_statuses['task-3']).toBe('pending');

    // task-results.json records the failed task
    const tr = JSON.parse(readFileSync(join(repoDir, '.agent', 'task-results.json'), 'utf8'));
    expect(tr.results.some((r: { task_id: string; status: string }) => r.task_id === 'task-1' && r.status === 'failed')).toBe(true);
  }, 120000);

  it('resumes from the failed task index, skipping passed tasks', async () => {
    // First run: developer blocks once on task-1 (task-block-once behavior),
    // then succeeds on resume. Run BLOCKED at task index 0.
    repoDir = createTestRepo('seq-resume', {
      planner: 'task-graph',
      developer: 'task-block-once',
    });
    const first = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a multi-part feature',
      task_slug: 'resume-test',
      max_iterations: 1,
    });
    expect(first.phase).toBe('BLOCKED');

    // Capture state before resume
    const stateBefore = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
    const failedIndex = stateBefore.task_graph_state.current_task_index;
    expect(failedIndex).toBe(0);

    // Resume: developer now succeeds (sentinel exists). Should restart from the
    // failed task (index 0) and complete all remaining tasks. No config change.
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      task_slug: 'resume-test',
      max_iterations: 3,
      resume_from: {
        run_id: stateBefore.run_id,
        iteration: stateBefore.iteration,
        phase: stateBefore.phase,
        branch: stateBefore.branch,
        base_commit: stateBefore.base_commit,
        task_slug: stateBefore.task_slug,
        goal_digest: stateBefore.goal_digest,
      },
    });

    // Resume should complete all tasks and end in PASSED.
    expect(resumeResult.phase).toBe('PASSED');
    expect(resumeResult.commit_sha).toBeTruthy();

    // All tasks passed after resume
    const stateAfter = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
    const statuses = stateAfter.task_graph_state.task_statuses;
    expect(Object.values(statuses).every((v: string) => v === 'passed')).toBe(true);
  }, 180000);
});

// ─── Phase 8D P6.5: idle watchdog cancels a silently hanging Developer ──
describe('Phase 8D P6.5: idle watchdog', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('cancels a silently hanging task Developer via the idle watchdog and reports BLOCKED', async () => {
    // Tiny idle window so the watchdog trips in ~1s; agent timeout stays high
    // so the idle watchdog (not the agent timeout) is what aborts the attempt.
    repoDir = createTestRepo('idle-watchdog', {
      planner: 'task-graph',
      developer: 'hang-silent',
    }, {
      kill_grace_seconds: 1,
      max_log_bytes: 10485760,
      lock_stale_seconds: 86400,
      cancel_grace_seconds: 1,
      agent_idle_timeout_seconds: 1,
    });

    const startedAt = Date.now();
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Run task graph',
      task_slug: 'idle-watchdog',
      max_iterations: 1,
    });
    const durationMs = Date.now() - startedAt;

    // The run reaches BLOCKED (not stuck in DEVELOPING).
    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
    expect(result.error?.code).toBe('VERIFICATION_FAILED');
    // Actionable idle-timeout detail reaches the result message.
    expect(result.message).toMatch(/idle watchdog|stalled|idle timeout/i);
    // Cancelled quickly — well under the 5min hang or the 60s agent timeout.
    expect(durationMs).toBeLessThan(15000);

    // iteration-log.md records the stall/timeout event with actionable detail.
    const log = readFileSync(join(repoDir, '.agent', 'iteration-log.md'), 'utf8');
    expect(log).toMatch(/idle watchdog|stalled|idle timeout/i);

    // task-results.json contains a failed result for the stalled task.
    const tr = JSON.parse(readFileSync(join(repoDir, '.agent', 'task-results.json'), 'utf8'));
    expect(tr.results.some((r: { task_id: string; status: string }) => r.task_id === 'task-1' && r.status === 'failed')).toBe(true);

    // progress.json also surfaces the stall/timeout event for monitors.
    const progress = JSON.parse(readFileSync(join(repoDir, '.agent', 'progress.json'), 'utf8'));
    expect(progress.last_event).toMatch(/idle watchdog|stalled|idle timeout/i);

    // state.json shows the task reached 'failed' (BLOCKED), not stuck running.
    const state = JSON.parse(readFileSync(join(repoDir, '.agent', 'state.json'), 'utf8'));
    expect(state.task_graph_state.task_statuses['task-1']).toBe('failed');
  }, 30000);
});
